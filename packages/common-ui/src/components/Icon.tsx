export function Icon({ name }: { name: "refresh" | "logout" | "user" }) {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {name === "refresh" ? (
        <>
          <path d="M20 7v5h-5M4 17v-5h5" />
          <path d="M6.1 6a8 8 0 0 1 13.2 3L20 12M4 12l.7 3A8 8 0 0 0 17.9 18" />
        </>
      ) : name === "logout" ? (
        <>
          <path d="M9 4H4v16h5M10 12h10m-4-4 4 4-4 4" />
        </>
      ) : (
        <>
          <circle cx="12" cy="8" r="4" />
          <path d="M4 21v-2a8 8 0 0 1 16 0v2" />
        </>
      )}
    </svg>
  );
}
