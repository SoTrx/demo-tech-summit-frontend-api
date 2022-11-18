import express, { RequestHandler } from "express";
import { json } from "express";
import cors from "cors";
import { env } from "process";
import {
  ConnectedRequest,
  UserEventRequest,
  UserEventResponseHandler,
  WebPubSubEventHandler,
} from "@azure/web-pubsub-express";
import { WebPubSubServiceClient } from "@azure/web-pubsub";
import { DaprClient } from "@dapr/dapr";
import {
  IImageReply,
  IImgRequest,
  IQueueConfig,
  IWebPubSubConfig,
} from "./server-api";

/** Env variables */
// Main server port
const PORT = env.PORT ?? 8081;
// WebPubSub hub
const WPS_CONFIG: IWebPubSubConfig = {
  hubName: env.HUB_NAME ?? "imagesgen",
  qs: env.WPS_QS,
};
// Queue
const QUEUE_CONFIG: IQueueConfig = {
  name: env.QUEUE_NAME ?? "queue",
  inTopic: env.QUEUE_TOPIC_TO_GENERATE ?? "to-generate",
  outTopic: env.QUEUE_TOPIC_GENERATED ?? "generated",
};
// Dapr name
const daprClient = new DaprClient();
const daprImgSub = [
  {
    pubsubname: QUEUE_CONFIG.name,
    topic: QUEUE_CONFIG.outTopic,
    route: "/newImage",
  },
];

// A sample image request used in testing
const sampleImgReq: IImgRequest = {
  requestId: "test",
  prompt: "A duck flying in the sky",
};

// A map containing all generated images payload
// In a real deployment, this MUST be deleted, as it makes
// this service stateful
// This variable only exists to allow for a client to "long poll"
// their request id
const genBacklog: Map<string, Omit<IImageReply, "uId">> = new Map();

async function main() {
  const app = express();
  app.use(cors());
  // This allows express to parse Cloudevents
  app.use(json({ type: "application/*+json" }));
  // Azure Web PubSub is used to communicate with the client
  // However, in some cases, this service can be used without
  // a pubsub.
  const isWPSEnabled = WPS_CONFIG.qs != undefined && WPS_CONFIG.qs !== "";
  let wpsClient: WebPubSubServiceClient;
  if (isWPSEnabled) {
    wpsClient = new WebPubSubServiceClient(WPS_CONFIG.qs, WPS_CONFIG.hubName);
    app.use(setupWpsHandler(wpsClient));
  } else
    console.error("Web pubsub QS is not defined. Web pubsub won't be used.");

  /** Router **/
  // Register dapr subscriptions
  app.get("/dapr/subscribe", (_, res) => res.json(daprImgSub));

  // Demo async test endpoint
  app.get("/test", async (req, res) => {
    const isEmpty = (s: string) => s == undefined || s == "";
    const promptInput = req.query?.prompt as string;
    const rIdInput = req.query?.rId as string;
    const prompt = isEmpty(promptInput) ? sampleImgReq.prompt : promptInput;
    const requestId = isEmpty(rIdInput) ? sampleImgReq.requestId : rIdInput;
    const payload = Object.assign(sampleImgReq, { prompt, requestId });
    console.log(payload);
    await handleImageRequest("test", payload);
    res.send("OK");
  });

  app.get("/lookup", (req, res) => {
    const rId = req.query?.rId as string;
    if (!rId) {
      res.status(400).send("A requestId must be supplied");
      return;
    }
    if (!genBacklog.has(rId)) {
      console.log(`Lookup for request "${rId}: Not found"`);
      console.log(`Content fo map"`);
      console.log([...genBacklog.entries()]);
      res.status(404).send("Not found");
    } else {
      console.log(
        `Lookup for request "${rId}: Ok : ${JSON.stringify(
          genBacklog.get(rId)
        )}"`
      );
      res.status(200).send(genBacklog.get(rId));
    }
  });

  // Every new image generated will be handled by this endpoint
  app.post("/newImage", async (req, res) => {
    console.log("new image received");
    console.log(JSON.stringify(req.body));
    await handleImageReceived(req?.body?.data, wpsClient);
    res.status(200).send("OK");
  });
  // Global error handler
  app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).send({ status: "DROP" });
  });

  app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
}

/**
 * Setup a trap for events in Azure Web Pub Sub
 * @param client
 */
function setupWpsHandler(client: WebPubSubServiceClient): RequestHandler {
  console.log("Setting up WPS handler");
  // Handle a newly connected user
  async function onNewUser(req: ConnectedRequest) {
    console.log(`${req.context.userId} connected`);
    await client.sendToAll({
      type: "system",
      message: `${req.context.userId} joined`,
    });
  }
  // Handle a new user event, in this case a new image request
  async function onNewRequest(
    req: UserEventRequest,
    res: UserEventResponseHandler
  ) {
    console.log("New request from ws")
    if (req.context.eventName === "message") {
      const [imgReq, valid] = ensureParsed<IImgRequest>(req.data);
      if (!valid) {
        console.warn(`Invalid payload received ${JSON.stringify(req.data)}`);
        return;
      }
      await handleImageRequest(req.context.userId, imgReq);
    }
    res.success();
  }
  const handler = new WebPubSubEventHandler(WPS_CONFIG.hubName, {
    path: "/eventhandler",
    onConnected: async (req: ConnectedRequest) => await onNewUser(req),
    handleUserEvent: async (req, res) => await onNewRequest(req, res),
  });
  return handler.getMiddleware();
}

/**
 * Handle a new image generation request
 * @param userId
 * @param req
 */
async function handleImageRequest(userId: string, req: IImgRequest) {
  const payload = {
    uId: userId,
    input: req.prompt,
    rId: req.requestId,
  };
  await daprClient.pubsub.publish(
    QUEUE_CONFIG.name,
    QUEUE_CONFIG.inTopic,
    payload
  );
}

/**
 * Reacts to a new image being generated. Forwards the image infos to
 * the original asker using webpubsub
 * @param payload
 * @param wpsClient
 */
async function handleImageReceived(
  payload: IImageReply,
  wpsClient?: WebPubSubServiceClient
) {
  if (payload === undefined) {
    console.log("Ignored event with empty payload");
    return;
  }
  const [imgData, valid] = ensureParsed<IImageReply>(payload);
  if (!valid) {
    console.warn(`Invalid payload received "${JSON.stringify(imgData)}"`);
    return;
  }
  const retPayload = {
    imageId: imgData.imageId,
    requestId: imgData.requestId,
  };
  console.log(`Image for rId ${imgData.requestId} received`);
  genBacklog.set(imgData.requestId, retPayload);
  await wpsClient?.sendToUser(imgData.uId, retPayload);
}

/**
 * Ensure the passed data in a valid object
 * Return the parsed object and a boolean
 * boolean is false if the object isn't valid
 * @param data
 */
function ensureParsed<T>(data: any): [T, boolean] {
  let res: T = data;
  if (typeof data === "string") {
    try {
      res = JSON.parse(data);
    } catch (e) {
      return [undefined, false];
    }
  }
  return [res, true];
}

main().catch(console.error);
