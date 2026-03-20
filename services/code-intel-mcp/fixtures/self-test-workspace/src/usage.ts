import { buildGreeting } from './definitions.js';

const message = buildGreeting('SampleProject');

export function getMessage(): string {
  return message;
}
