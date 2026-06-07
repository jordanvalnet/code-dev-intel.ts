export function targetCallee(value: number): number {
  return helperDouble(value) + 1;
}

export function helperDouble(value: number): number {
  return value * 2;
}

export function firstCaller(): number {
  return targetCallee(10);
}

export function secondCaller(): number {
  const intermediate = targetCallee(20);
  return targetCallee(intermediate);
}
