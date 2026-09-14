import { Badge } from "@mantine/core";
export function Status({ value }: { value: string }) {
  return (
    <Badge
      variant="light"
      color={
        ["completed", "connected", "authenticated"].includes(value)
          ? "teal"
          : ["failed", "cancelled", "offline"].includes(value)
            ? "red"
            : "blue"
      }
    >
      {value}
    </Badge>
  );
}
