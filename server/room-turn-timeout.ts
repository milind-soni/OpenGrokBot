export function roomTurnTimeoutMs(minutes: number): number {
  return minutes * 60_000;
}

export function scheduleRoomTurnTimeout(
  minutes: number,
  onTimeout: () => void,
): ReturnType<typeof setTimeout> {
  return setTimeout(onTimeout, roomTurnTimeoutMs(minutes));
}

export function roomTurnTimeoutMessage(botName: string, minutes: number): string {
  const unit = minutes === 1 ? "minute" : "minutes";
  return `${botName}'s room turn exceeded ${minutes} ${unit} and was stopped`;
}
