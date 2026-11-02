import type { IChannelClient } from "@zcode/rpc";
import { createBrowserAccountBridge } from "./index.js";

/** Parent wraps only attachment.oauth in accountPolicy and registers it for this socket. */
export async function browserAccountBridgeExample(client: IChannelClient) {
  const bridge = createBrowserAccountBridge("https://account.example.test", {
    onOwnerChanged: async () => {
      /* Invalidate the existing Host account catalog. */
    },
  });
  const attachment = bridge.attach(client);
  await attachment.ready;
  return {
    oauth: attachment.oauth,
    dispose: () => {
      attachment.dispose();
      bridge.dispose();
    },
  };
}
