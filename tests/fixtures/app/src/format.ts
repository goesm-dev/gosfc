export function formatPrice(yen: number): string {
  return `¥${yen.toLocaleString("en-US")}`;
}
