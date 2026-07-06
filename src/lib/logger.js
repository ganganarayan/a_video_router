export function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

export function logError(...args) {
  console.error(new Date().toISOString(), 'ERROR', ...args);
}
