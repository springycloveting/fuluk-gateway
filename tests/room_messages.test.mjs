import assert from "node:assert/strict";
import test from "node:test";
import { isNearScrollBottom, roomMessagesSignature } from "../public/room_messages.js";

test("room message signature only changes for visible message data", () => {
  const messages = [{ id: "m1", text: "hello", deliveries: [{ id: 1, status: "sent", error: null }] }];
  assert.equal(roomMessagesSignature(messages), roomMessagesSignature(structuredClone(messages)));
  const changed = structuredClone(messages);
  changed[0].deliveries[0].status = "failed";
  assert.notEqual(roomMessagesSignature(messages), roomMessagesSignature(changed));
});

test("room history only follows updates when the reader is near the bottom", () => {
  assert.equal(isNearScrollBottom({ scrollHeight: 1000, scrollTop: 700, clientHeight: 200 }), false);
  assert.equal(isNearScrollBottom({ scrollHeight: 1000, scrollTop: 750, clientHeight: 200 }), true);
});
