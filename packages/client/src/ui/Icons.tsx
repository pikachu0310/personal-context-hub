import {
  IconDeviceLaptop,
  IconGitBranch,
  IconUser,
  IconFileDiff,
  IconEdit,
  IconFolder,
  IconSearch,
  IconAdjustmentsHorizontal,
  IconLayoutSidebar,
  IconTerminal2,
  IconArrowUp,
  IconPlayerStop,
  IconCheck,
  IconChevronRight,
  IconFileText,
  IconShieldCheck,
  IconPlus,
  IconX,
  IconRefresh,
  IconListDetails,
  IconRobot,
  IconDots,
} from "@tabler/icons-react";
const icons = {
  computer: IconDeviceLaptop,
  branch: IconGitBranch,
  person: IconUser,
  changes: IconFileDiff,
  compose: IconEdit,
  folder: IconFolder,
  search: IconSearch,
  settings: IconAdjustmentsHorizontal,
  panel: IconLayoutSidebar,
  terminal: IconTerminal2,
  arrow: IconArrowUp,
  stop: IconPlayerStop,
  check: IconCheck,
  chevron: IconChevronRight,
  file: IconFileText,
  shield: IconShieldCheck,
  plus: IconPlus,
  close: IconX,
  refresh: IconRefresh,
  details: IconListDetails,
  bot: IconRobot,
  dots: IconDots,
};
export function Icon({
  name,
  size = 18,
}: {
  name: keyof typeof icons;
  size?: number;
}) {
  const Component = icons[name];
  return <Component size={size} stroke={1.7} aria-hidden="true" />;
}
