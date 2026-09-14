import {
  IconRefresh,
  IconLogout,
  IconUser,
  IconDots,
} from "@tabler/icons-react";
const icons = {
  refresh: IconRefresh,
  logout: IconLogout,
  user: IconUser,
  dots: IconDots,
};
export function Icon({ name }: { name: keyof typeof icons }) {
  const Component = icons[name];
  return <Component size={18} stroke={1.7} aria-hidden="true" />;
}
