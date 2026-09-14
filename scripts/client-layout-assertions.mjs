import assert from "node:assert/strict";

export async function verifyClientAlignment(page) {
  const plus = await page
    .getByRole("button", { name: "プロジェクトを追加", exact: true })
    .boundingBox();
  for (const button of await page.locator(".project-compose").all()) {
    const box = await button.boundingBox();
    assert.ok(
      Math.abs(plus.x + plus.width / 2 - box.x - box.width / 2) < 1,
      "project plus centers align",
    );
  }
  const input = page.getByLabel("タスクを検索");
  await input.focus();
  assert.equal(
    await input.evaluate((el) => globalThis.getComputedStyle(el).outlineStyle),
    "none",
  );
  assert.equal(
    await input.evaluate((el) => globalThis.getComputedStyle(el).boxShadow),
    "none",
  );
  for (const button of await page.locator(".composer-dropdown").all()) {
    assert.ok(await button.locator("svg").count());
    assert.ok(!(await button.innerText()).includes("⌄"));
    const aligned = await button.evaluate((el) => {
      const range = globalThis.document.createRange();
      range.selectNode(el.firstChild);
      const text = range.getBoundingClientRect(),
        icon = el.querySelector("svg").getBoundingClientRect();
      return Math.abs(text.y + text.height / 2 - icon.y - icon.height / 2) < 3;
    });
    assert.ok(aligned, "dropdown text and icon centers align");
  }
  const action = page.locator(".inspector-action");
  if ((await action.count()) && (await action.isVisible())) {
    assert.equal(
      await action.evaluate(
        (el) => globalThis.getComputedStyle(el).paddingLeft,
      ),
      "0px",
    );
    const x = (await action.boundingBox()).x;
    const row = await page
      .locator(".task-inspector .environment-row")
      .first()
      .boundingBox();
    assert.ok(
      Math.abs(x - row.x) < 1,
      "environment action uses the same left edge as the rows",
    );
  }
  const status = page
    .locator(".inspector-section .environment-row")
    .filter({ hasText: "状態" });
  if ((await status.count()) && (await status.isVisible())) {
    const centers = await status.evaluate((el) =>
      [el.firstElementChild, ...el.lastElementChild.children].map((child) => {
        const box = child.getBoundingClientRect();
        return box.y + box.height / 2;
      }),
    );
    assert.ok(
      Math.max(...centers) - Math.min(...centers) < 1,
      "status label, dot and value align",
    );
    assert.ok(await page.locator(".task-owner .user-avatar").count());
  }
}

export async function verifyProjectDrafts(page) {
  const requests = [];
  let mode = "fail",
    release;
  const original = () =>
    page.locator('.task-row[data-task-id="task"] .task-link').click();
  const input = page.getByLabel("新しいタスクへの依頼");
  const plus = page.getByRole("button", {
    name: "discord-voiceに新しいタスクを追加",
    exact: true,
  });
  await page.route("**/api/project/task", async (route) => {
    const request = route.request().postDataJSON();
    requests.push(request);
    if (mode === "hold")
      await new Promise((resolve) => {
        release = resolve;
      });
    await route.fulfill({
      status: mode === "fail" ? 503 : 200,
      contentType: "application/json",
      body: JSON.stringify(
        mode === "fail"
          ? { error: "RESULT_UNCONFIRMED" }
          : { id: "created-task", projectId: request.projectId },
      ),
    });
  });
  await page
    .getByRole("button", { name: "discord-voiceの設定", exact: true })
    .click();
  await page
    .getByRole("menuitem", { name: "新しいタスク", exact: true })
    .click();
  await input.waitFor();
  assert.equal(await page.getByRole("dialog").count(), 0);
  await original();
  assert.equal(await page.locator(".draft-task-row").count(), 0);
  await plus.click();
  await input.fill("復元する本文\n二行目");
  const draftAvatar = await page
    .locator(".draft-task-row .user-avatar")
    .last()
    .boundingBox();
  const realAvatar = await page
    .locator('.task-row[data-task-id="task"] .user-avatar')
    .last()
    .boundingBox();
  assert.ok(
    Math.abs(
      draftAvatar.x +
        draftAvatar.width / 2 -
        realAvatar.x -
        realAvatar.width / 2,
    ) < 1,
  );
  await page.screenshot({ path: ".ido-build/screenshots/workspace-draft.png" });
  await page
    .getByRole("button", {
      name: "team-toolsに新しいタスクを追加",
      exact: true,
    })
    .click();
  assert.equal(await input.inputValue(), "");
  await input.fill("別プロジェクトの本文");
  await original();
  assert.equal(await page.locator(".draft-task-row").count(), 0);
  await plus.click();
  assert.equal(await input.inputValue(), "復元する本文\n二行目");
  assert.equal(requests.length, 0, "opening and editing never creates tasks");
  await page.getByRole("button", { name: "送信", exact: true }).click();
  await page
    .getByRole("alert")
    .filter({ hasText: "RESULT_UNCONFIRMED" })
    .waitFor();
  const sentId = requests[0].requestId;
  await original();
  assert.equal(await page.locator(".draft-task-row").count(), 1);
  await plus.click();
  assert.equal(await input.inputValue(), "復元する本文\n二行目");
  mode = "hold";
  await page.getByRole("button", { name: "送信", exact: true }).click();
  await input.waitFor({ state: "visible" });
  await original();
  await plus.click();
  assert.ok(
    await page.getByRole("button", { name: "送信", exact: true }).isDisabled(),
  );
  await original();
  for (let i = 0; !release && i < 100; i++)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(release);
  release();
  await page.locator(".draft-task-row").waitFor({ state: "hidden" });
  assert.equal(requests[1].requestId, sentId);
  assert.equal(
    await input.count(),
    0,
    "completion does not interrupt navigation",
  );
  assert.ok(await page.getByLabel("エージェントへの追加指示").count());
  await plus.click();
  assert.equal(await input.inputValue(), "");
  await input.fill("リロードで消える本文");
  await original();
  await page.reload();
  await plus.click();
  assert.equal(await input.inputValue(), "");
  await original();
  await page.unroute("**/api/project/task");
}

export async function verifyChangesWidth(page, inspector) {
  await page.waitForFunction(
    () =>
      Math.abs(
        globalThis.document
          .querySelector(".task-inspector")
          .getBoundingClientRect().width - 340,
      ) < 1,
  );
  const sample = async (target) =>
    page.evaluate(async (target) => {
      const panel = globalThis.document.querySelector(".task-inspector");
      const chat = globalThis.document.querySelector(".task-conversation");
      const widths = [
        [
          panel.getBoundingClientRect().width,
          chat.getBoundingClientRect().width,
        ],
      ];
      [...panel.querySelectorAll('[role="tab"]')]
        .find(
          (tab) =>
            tab.textContent.trim() === (target === "changes" ? "変更" : "環境"),
        )
        .click();
      const start = globalThis.performance.now();
      await new Promise((resolve) => {
        const frame = () => {
          widths.push([
            panel.getBoundingClientRect().width,
            chat.getBoundingClientRect().width,
          ]);
          if (globalThis.performance.now() - start >= 400) resolve();
          else globalThis.requestAnimationFrame(frame);
        };
        globalThis.requestAnimationFrame(frame);
      });
      return widths;
    }, target);
  const widths = await sample("changes");
  const [panel, chat] = widths.at(-1);
  assert.ok(
    Math.abs(panel - chat) < 2,
    "changes takes half the available workspace",
  );
  assert.ok(
    widths.some(([width]) => width > 343 && width < panel - 3),
    "panel widens smoothly",
  );
  assert.ok(
    widths.some(([, width]) => width > chat + 3 && width < widths[0][1] - 3),
    "chat narrows smoothly",
  );
  await page.screenshot({
    path: ".ido-build/screenshots/workspace-changes-wide.png",
  });
  const action = page.locator(
    ".composer-toolbar > .stop-button, .composer-toolbar > .send-button",
  );
  const actionBox = await action.boundingBox(),
    toolbar = await page.locator(".composer-toolbar").boundingBox();
  assert.ok(
    Math.abs(actionBox.x + actionBox.width - toolbar.x - toolbar.width) < 1,
    "wrapped composer action stays right aligned",
  );
  const viewport = page.viewportSize();
  await page.setViewportSize({ ...viewport, width: viewport.width + 120 });
  await page.waitForFunction(
    () =>
      Math.abs(
        globalThis.document
          .querySelector(".task-inspector")
          .getBoundingClientRect().width -
          globalThis.document
            .querySelector(".task-conversation")
            .getBoundingClientRect().width,
      ) < 2,
  );
  await page.setViewportSize(viewport);
  await sample("environment");
  assert.ok(Math.abs((await inspector.boundingBox()).width - 340) < 1);
  // Reverse a width transition before it settles.
  await inspector.getByRole("tab", { name: "変更", exact: true }).click();
  await inspector.getByRole("tab", { name: "環境", exact: true }).click();
  await page.waitForFunction(
    () =>
      Math.abs(
        globalThis.document
          .querySelector(".task-inspector")
          .getBoundingClientRect().width - 340,
      ) < 1,
  );
  await page.emulateMedia({ reducedMotion: "reduce" });
  await inspector.getByRole("tab", { name: "変更", exact: true }).click();
  assert.equal(
    await inspector.evaluate(
      (el) => globalThis.getComputedStyle(el).transitionDuration,
    ),
    "0s",
  );
  await inspector.getByRole("tab", { name: "環境", exact: true }).click();
  await page.emulateMedia({ reducedMotion: "no-preference" });
}

export async function verifyMobileChanges(page) {
  const panel = page.locator(".mantine-Drawer-content");
  await page.getByRole("tab", { name: "変更", exact: true }).click();
  await page.waitForFunction(
    () =>
      Math.abs(
        globalThis.document
          .querySelector(".mantine-Drawer-content")
          .getBoundingClientRect().width - globalThis.innerWidth,
      ) < 1,
  );
  await panel
    .locator(".diff-preview")
    .filter({ hasText: "diff --git" })
    .waitFor();
  await page.screenshot({
    path: ".ido-build/screenshots/workspace-mobile-changes.png",
  });
  await page.getByRole("tab", { name: "環境", exact: true }).click();
  await page.waitForFunction(
    () =>
      Math.abs(
        globalThis.document
          .querySelector(".mantine-Drawer-content")
          .getBoundingClientRect().width - Math.min(380, globalThis.innerWidth),
      ) < 1,
  );
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.getByRole("tab", { name: "変更", exact: true }).click();
  assert.equal(
    await panel.evaluate(
      (el) => globalThis.getComputedStyle(el).transitionDuration,
    ),
    "0s",
  );
  await page.getByRole("tab", { name: "環境", exact: true }).click();
  await page.emulateMedia({ reducedMotion: "no-preference" });
}
