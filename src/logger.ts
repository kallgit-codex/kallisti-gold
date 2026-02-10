export function log(message: string) {
  console.log("[" + new Date().toISOString() + "] " + message);
}

export function error(message: string) {
  console.error("[" + new Date().toISOString() + "] ERROR: " + message);
}

