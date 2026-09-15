import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  StringSelectMenuBuilder,
  type Interaction,
} from "discord.js";
import type { DiscordState } from "../runtime/state.js";
import { discordUserAllowed } from "../input/policy.js";

const prefix = "ido-project:";
type Listing = Awaited<ReturnType<NonNullable<DiscordState["projectCommand"]>>>;
const normalize = (value: string) =>
  value.normalize("NFKC").trim().toLowerCase();
const label = (value: string) => value.replace(/[\r\n]+/g, " ").slice(0, 100);

function picker(listing: Listing, requestedPage: number) {
  const pages = Math.max(1, Math.ceil(listing.projects.length / 25));
  const page = Math.max(0, Math.min(pages - 1, requestedPage));
  const projects = listing.projects.slice(page * 25, (page + 1) * 25);
  const current = listing.projects.find((p) => p.id === listing.projectId);
  const components: Array<
    ActionRowBuilder<StringSelectMenuBuilder> | ActionRowBuilder<ButtonBuilder>
  > = [];
  if (projects.length) {
    components.push(
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`${prefix}select`)
          .setPlaceholder("参加するプロジェクトを選択")
          .addOptions(
            projects.map((p) => ({
              label: label(p.name),
              value: p.id,
              description: label(
                `${p.id === listing.projectId ? "現在の参加先 · " : ""}${p.id}`,
              ),
              default: p.id === listing.projectId,
            })),
          ),
      ),
    );
  }
  if (pages > 1) {
    components.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`${prefix}page:${page - 1}`)
          .setLabel("前へ")
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(page === 0),
        new ButtonBuilder()
          .setCustomId(`${prefix}page:${page + 1}`)
          .setLabel("次へ")
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(page === pages - 1),
      ),
    );
  }
  return {
    content: `現在のプロジェクト: ${label(current?.name ?? listing.projectId)}\n${projects.length ? "参加先を候補から選んでください。" : "選択できるプロジェクトがありません。"}${pages > 1 ? `（${page + 1}/${pages}ページ）` : ""}`,
    components,
    allowedMentions: { parse: [] as const },
  };
}

export function isProjectInteraction(interaction: Interaction) {
  return interaction.isAutocomplete() || interaction.isChatInputCommand()
    ? interaction.commandName === "project"
    : (interaction.isButton() || interaction.isStringSelectMenu()) &&
        interaction.customId.startsWith(prefix);
}

export async function handleProjectInteraction(
  state: Pick<DiscordState, "config" | "projectCommand">,
  interaction: Interaction,
) {
  if (!isProjectInteraction(interaction)) return;
  const allowed =
    interaction.guildId === state.config.guildId &&
    discordUserAllowed(state.config, interaction.user.id);
  if (interaction.isAutocomplete()) {
    if (!allowed) return void (await interaction.respond([]));
    let choices: Array<{ name: string; value: string }> = [];
    try {
      const listing = await state.projectCommand!(interaction.user.id);
      const query = normalize(interaction.options.getFocused());
      choices = listing.projects
        .filter(
          (p) =>
            normalize(p.name).includes(query) ||
            normalize(p.id).includes(query),
        )
        .slice(0, 25)
        .map((p) => ({ name: label(p.name), value: p.id }));
    } catch {
      /* Unavailable or unauthorized listings disclose no projects. */
    }
    await interaction.respond(choices);
    return;
  }
  if (
    !interaction.isChatInputCommand() &&
    !interaction.isButton() &&
    !interaction.isStringSelectMenu()
  )
    return;
  if (!allowed) {
    await interaction.reply({
      content:
        "このサーバー・ユーザーにはプロジェクトを選択する権限がありません。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  if (interaction.isChatInputCommand())
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  else await interaction.deferUpdate();
  try {
    const selection = interaction.isChatInputCommand()
      ? (interaction.options.getString("name") ?? undefined)
      : interaction.isStringSelectMenu()
        ? interaction.values[0]
        : undefined;
    const listing = await state.projectCommand!(interaction.user.id, selection);
    const page = interaction.isButton()
      ? Number(interaction.customId.slice(`${prefix}page:`.length))
      : 0;
    await interaction.editReply(
      picker(listing, Number.isSafeInteger(page) ? page : 0),
    );
  } catch {
    await interaction.editReply({
      content:
        "切り替えできません。受付権限を確認し、/project で最新の候補を表示してください。",
      components: [],
      allowedMentions: { parse: [] },
    });
  }
}
