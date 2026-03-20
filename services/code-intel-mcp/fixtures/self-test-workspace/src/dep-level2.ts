import { depLevel1 } from './dep-level1.js';
import { basename } from 'node:path';

export function depLevel2(name: string): string {
  return depLevel1(basename(name));
}
