import { env } from "process";

export interface IImageReply {
  uId: string;
  imageId: string;
  requestId: string;
}

interface IImgRequest {
  prompt: string;
  requestId: string;
}

// WebPubSub hub
interface IWebPubSubConfig {
  hubName: string;
  qs: string;
}
// Queue
interface IQueueConfig {
  name: string;
  inTopic: string;
  outTopic: string;
}
