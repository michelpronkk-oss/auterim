import { spawn } from "node:child_process";

export function openApprovalUrl(url: string, platform = process.platform): Promise<boolean> {
  const [command, args] =
    platform === "win32"
      ? ["rundll32.exe", ["url.dll,FileProtocolHandler", url]]
      : platform === "darwin"
        ? ["open", [url]]
        : ["xdg-open", [url]];
  return new Promise((resolve) => {
    let settled = false;
    let started = false;
    const timeout = setTimeout(() => finish(started), 1_500);
    const finish = (opened: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(opened);
    };
    try {
      const child = spawn(command, args, {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
        shell: false,
      });
      child.once("spawn", () => {
        started = true;
        child.unref();
      });
      child.once("error", () => finish(false));
      child.once("close", (code) => finish(code === 0));
    } catch {
      finish(false);
    }
  });
}
