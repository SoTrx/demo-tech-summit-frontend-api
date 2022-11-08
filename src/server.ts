import express from "express";
import { json } from "express";
import { env } from "process";
import {
  UserEventRequest,
  UserEventResponseHandler,
  WebPubSubEventHandler,
} from "@azure/web-pubsub-express";
import { WebPubSubServiceClient } from "@azure/web-pubsub";

const PORT = env.PORT ?? 8081;
const HUB_NAME = env.HUB_NAME ?? "imagesgen";
const WPS_QS = env.WPS_QS;
const QUEUE_NAME = env.QUEUE_NAME ?? "queue";
const QUEUE_TOPIC_TO_GENERATE = env.QUEUE_TOPIC_TO_GENERATE ?? "to-generate";
const QUEUE_TOPIC_GENERATED = env.QUEUE_TOPIC_GENERATED ?? "generated";

const app = express();
app.use(json({ type: "application/*+json" }));

const serviceClient = new WebPubSubServiceClient(WPS_QS, HUB_NAME);
import {  DaprClient } from "@dapr/dapr";
import { IImageReply } from "./server-api";
import { exit } from "process";


const daprClient = new DaprClient();
console.log(process.env.DAPR_HTTP_PORT);

async function onNewImage(data: IImageReply) {
  if (data === undefined) {
    console.log("Ignored event with empty payload");
    return;
  }
  // The library parses JSON when possible.
  console.log(
    `[Dapr-JS][Example] Received on subscription: ${JSON.stringify(data)}`
  );
  await serviceClient.sendToUser(data.rId, { id: data.imageId });
}

async function onUserMessage(
  req: UserEventRequest,
  res: UserEventResponseHandler
) {
  if (req.context.eventName === "message") {
    // TODO : Send rq to queue
    const payload = { rId: req.context.userId, input: req.data };
    console.log(JSON.stringify(req));
    console.log(JSON.stringify(payload));
    await daprClient.pubsub.publish(
      QUEUE_NAME,
      QUEUE_TOPIC_TO_GENERATE,
      payload
    );
  }
  res.success();
}
app.get("/test", async (req, res) => {
  console.log("test");
  await onUserMessage(
    {
      // @ts-ignore
      context: { userId: "test", eventName: "message" },
      data: " A duck flying in the sky",
    },
    { success: () => true }
  );
  res.send("OK");
});

app.post("/newImage", async (req, res) => {
  console.log("new image received");
  console.log(JSON.stringify(req.body));
  try {
    await onNewImage(req?.body?.data);
    res.status(200).send("OK");
  } catch (e) {
    res.status(500).send({ status: "DROP" });
  }
});

// Retrieve a token to access the web pubsub boker
/*app.get("/negotiate", async (req, res) => {
  const id = uuid();
  const token = await serviceClient.getClientAccessToken({ userId: id });
  res.json({ url: token.url, id });
});*/

async function main() {
  if (env.WPS_QS === undefined) {
    console.error("Web pubsub QS is not defined. Aborting.");
    exit(1);
  }
  const handler = new WebPubSubEventHandler(HUB_NAME, {
    /*handleConnect: (req, res) => {
      // auth the connection and set the userId of the connection
      res.success({
        userId: "<userId>",
      });
    },*/
    handleUserEvent: onUserMessage,
    //allowedEndpoints: ["https://<yourAllowedService>.webpubsub.azure.com"],
  });
  app.use(handler.getMiddleware());
  app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
}

main().catch(console.error);
