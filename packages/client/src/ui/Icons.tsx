const paths = {
  folder:
    "M3 7V5a1 1 0 0 1 1-1h5l2 2h9a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7Zm0 2h18",
  search: "M21 21l-5-5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0",
  settings: "M4 6h16M4 12h16M4 18h16M8 3v6M16 9v6M10 15v6",
  panel:
    "M9 3v18M4 3h16a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1",
  terminal: "m5 7 5 5-5 5m8 0h6",
  arrow: "M12 20V4m-6 6 6-6 6 6",
  stop: "M6 6h12v12H6z",
  check: "m5 12 4 4L19 6",
  chevron: "m9 5 7 7-7 7",
  file: "M14 2H5v20h14V7l-5-5Zm0 0v6h5M8 13h8M8 17h8",
  shield: "m12 2 8 3v7c0 5-8 10-8 10S4 17 4 12V5l8-3Z",
  plus: "M12 5v14M5 12h14",
  close: "m6 6 12 12M6 18 18 6",
  refresh: "M20 10a8 8 0 1 0-1 7M20 3v7h-7",
} as const;
export function Icon({
  name,
  size = 18,
}: {
  name: keyof typeof paths;
  size?: number;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[name]} />
    </svg>
  );
}
