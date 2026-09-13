import { loadBrowserConfig, startBrowserStudio } from "./index.mjs";

try {
  const config = await loadBrowserConfig(process.env.IDD_STUDIO_CONFIG);
  const service = await startBrowserStudio({ config });
  console.log(`共有スタジオ: ${service.server.url}`);
  console.log(
    `接続コード: ローカルの ${service.accessPath} を開いてください。`,
  );
  for (const signal of ["SIGINT", "SIGTERM"])
    process.once(
      signal,
      () =>
        void service.stop().then(
          () => {
            process.exitCode = 0;
          },
          (error) => {
            console.error(error.publicMessage ?? error.message);
            process.exitCode = 1;
          },
        ),
    );
} catch (error) {
  console.error(error.publicMessage ?? error.message);
  process.exitCode = 1;
}
