export function celsiusToFahrenheit(celsius: number): number {
  return (celsius * 9) / 5 + 32;
}

export function formatRoom(fahrenheit: number): string {
  return (Math.round(fahrenheit * 10) / 10).toFixed(1);
}

export function setpointAccent(setpoint: number, roomF: number): 'above' | 'below' | 'near' {
  const delta = setpoint - roomF;
  if (delta > 1) {
    return 'above';
  }
  if (delta < -1) {
    return 'below';
  }
  return 'near';
}
