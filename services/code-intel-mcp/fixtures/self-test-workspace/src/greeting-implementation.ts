import type { GreetingContract } from './contract.js';

export class GreetingService implements GreetingContract {
  getGreeting(name: string): string {
    return `Hello, ${name}`;
  }
}
