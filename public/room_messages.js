export function roomMessagesSignature(messages) {
  return JSON.stringify(messages.map((message) => [
    message.id,
    message.text,
    message.fromSessionName,
    message.targetMode,
    message.targetRole,
    message.createdAt,
    (message.deliveries ?? []).map((delivery) => [delivery.id, delivery.status, delivery.error])
  ]));
}

export function isNearScrollBottom(element, threshold = 80) {
  return element.scrollHeight - element.scrollTop - element.clientHeight <= threshold;
}
