import { buildGreeting } from './definitions.js';

export function depLevel1(name: string): string {
  return buildGreeting(name);
}
