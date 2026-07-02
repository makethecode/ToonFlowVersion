import { app, BrowserWindow, protocol, systemPreferences } from "electron";
import path from "path";
import fs from "fs";
import Module from "module";

// dev 模式自动加载 .env.local（tsx 不会自动读）
if (!app.isPackaged) {
  for (const file of [".env.local", ".env"]) {
    if (!fs.existsSync(file)) continue;
    for (const raw of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const m = line.match(/^([A-Z0-9_]+)\s*=\s*(.*)$/i);
      if (!m) continue;
      const k = m[1];
      let v = m[2];
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      if (process.env[k] === undefined) process.env[k] = v.replace(/\\n/g, "\n");
    }
    break;
  }
}

// 设置 userData：开发模式用项目本地目录，生产环境用系统默认路径（asar 内不可写）
const localUserData = app.isPackaged
  ? path.join(app.getPath("userData"), ".electron-data")
  : path.resolve(__dirname, "..", ".electron-data");
app.setPath("userData", localUserData);
fs.mkdirSync(localUserData, { recursive: true });

// 加速 Electron 启动：跳过 GPU 信息收集，减少初始化耗时
app.commandLine.appendSwitch("disable-gpu-shader-disk-cache");
app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion");

const TARGET_ENTRIES = new Set(["assets", "models", "serve", "skills", "web", "vendor"]);

function copyDir(src: string, dest: string): void {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    entry.isDirectory() ? copyDir(s, d) : fs.existsSync(d) || fs.copyFileSync(s, d);
  }
}

declare const __APP_VERSION__: string;
declare const __LICENSE_SERVER_URL__: string;

function compareVersions(a: string, b: string): number {
  const pa = a
    .split(".")
    .map((n) => Number.parseInt(n, 10))
    .filter((n) => Number.isFinite(n));
  const pb = b
    .split(".")
    .map((n) => Number.parseInt(n, 10))
    .filter((n) => Number.isFinite(n));
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const va = pa[i] ?? 0;
    const vb = pb[i] ?? 0;
    if (va > vb) return 1;
    if (va < vb) return -1;
  }
  return 0;
}

function initializeData(): void {
  const srcDir = path.join(process.resourcesPath, "data");
  const destDir = path.join(app.getPath("userData"), "data");
  const versionFilePath = path.join(destDir, "version.txt");

  let shouldForceReplace = false;
  if (!fs.existsSync(versionFilePath)) {
    shouldForceReplace = true;
  } else {
    const localVersion = fs.readFileSync(versionFilePath, "utf-8").trim();
    if (compareVersions(localVersion, __APP_VERSION__) < 0) {
      shouldForceReplace = true;
    }
  }

  for (const dir of TARGET_ENTRIES) {
    const targetDir = path.join(destDir, dir);
    if (shouldForceReplace) {
      fs.rmSync(targetDir, { recursive: true, force: true });
      copyDir(path.join(srcDir, dir), targetDir);
      continue;
    }
    if (!fs.existsSync(targetDir)) {
      copyDir(path.join(srcDir, dir), targetDir);
    }
  }

  if (shouldForceReplace) {
    fs.mkdirSync(destDir, { recursive: true });
    fs.writeFileSync(versionFilePath, `${__APP_VERSION__}\n`, "utf-8");
  }
}

//获取全部依赖路径，优先从 unpacked 加载原生模块，其他模块从 asar 加载
function getNodeModulesPaths(): string[] {
  const paths: string[] = [];
  if (app.isPackaged) {
    // external 依赖（原生模块）在 unpacked 目录
    const unpackedNodeModules = path.join(process.resourcesPath, "app.asar.unpacked", "node_modules");
    if (fs.existsSync(unpackedNodeModules)) {
      paths.push(unpackedNodeModules);
    }
    // 普通依赖在 asar 内
    const asarNodeModules = path.join(process.resourcesPath, "app.asar", "node_modules");
    paths.push(asarNodeModules);
  } else {
    paths.push(path.join(process.cwd(), "node_modules"));
  }
  return paths;
}

//动态加载
function requireWithCustomPaths(modulePath: string): any {
  const appNodeModulesPaths = getNodeModulesPaths();
  // 保存原始方法
  const originalNodeModulePaths = (Module as any)._nodeModulePaths;
  // 临时修改模块路径解析
  (Module as any)._nodeModulePaths = function (from: string): string[] {
    const paths = originalNodeModulePaths.call(this, from);
    // 将主程序的 node_modules 添加到前面
    for (let i = appNodeModulesPaths.length - 1; i >= 0; i--) {
      const p = appNodeModulesPaths[i];
      if (!paths.includes(p)) {
        paths.unshift(p);
      }
    }
    return paths;
  };
  try {
    // 清除缓存确保加载最新
    delete require.cache[require.resolve(modulePath)];
    return require(modulePath);
  } finally {
    // 恢复原始方法
    (Module as any)._nodeModulePaths = originalNodeModulePaths;
  }
}

let mainWindow: BrowserWindow | null = null;
let localApiBase = "";
let licenseServerUrl = "";
let showingLicensePage = false;
let licenseMonitor: NodeJS.Timeout | undefined;
let currentUser: { id: string; email: string; displayName: string; token: string } | null = null;
const userDataFile = () => path.join(app.getPath("userData"), "user-session.json");

function loadUserSession(): void {
  try {
    if (!app.isReady()) return;
    if (fs.existsSync(userDataFile())) {
      const raw = JSON.parse(fs.readFileSync(userDataFile(), "utf8"));
      if (raw && typeof raw.id === "string" && typeof raw.token === "string" && Date.now() < Number(raw.expiresAt ?? 0)) {
        currentUser = { id: raw.id, email: raw.email ?? "", displayName: raw.displayName ?? "", token: raw.token };
      } else {
        currentUser = null;
      }
    } else {
      currentUser = null;
    }
  } catch {
    currentUser = null;
  }
}

function saveUserSession(user: { id: string; email: string; displayName: string; token: string; expiresAt: number } | null): void {
  if (user) {
    currentUser = { id: user.id, email: user.email, displayName: user.displayName, token: user.token };
  } else {
    currentUser = null;
  }
  try {
    if (user) {
      fs.mkdirSync(path.dirname(userDataFile()), { recursive: true });
      fs.writeFileSync(userDataFile(), JSON.stringify(user), "utf8");
    } else if (fs.existsSync(userDataFile())) {
      fs.unlinkSync(userDataFile());
    }
  } catch (err) {
    console.warn("[UserSession] 写入失败", err);
  }
}

function getWebFile(name: string): string {
  const isDev = process.env.NODE_ENV === "dev" || !app.isPackaged;
  return isDev
    ? path.join(process.cwd(), "scripts", "web", name)
    : path.join(process.resourcesPath, "app.asar", "scripts", "web", name);
}

function getMainHtmlFile(): string {
  const isDev = process.env.NODE_ENV === "dev" || !app.isPackaged;
  return isDev
    ? path.join(process.cwd(), "data", "web", "index.html")
    : path.join(app.getPath("userData"), "data", "web", "index.html");
}

async function showLicensePage(): Promise<void> {
  if (!mainWindow) return;
  showingLicensePage = true;
  if (!currentUser) {
    await mainWindow.loadFile(getWebFile("login.html"));
  } else {
    await mainWindow.loadFile(getWebFile("license.html"));
  }
}

async function loadLocalAuth(): Promise<void> {
  if (!mainWindow) return;
  showingLicensePage = true; // treat auth page as license page so interval doesn't race
  await mainWindow.loadFile(getWebFile("local-auth.html"));
}

async function loadMainContent(): Promise<void> {
  if (!mainWindow) return;
  showingLicensePage = false;
  if (process.env.VITE_DEV) await mainWindow.loadURL("http://localhost:50188");
  else await mainWindow.loadFile(getMainHtmlFile());
}

async function checkLicenseAfterLogin(): Promise<void> {
  if (!mainWindow || showingLicensePage || mainWindow.webContents.isLoading()) return;
  try {
    const hasToken = await mainWindow.webContents.executeJavaScript("Boolean(localStorage.getItem('token'))", true);
    if (!hasToken) return;
    // 1) 无 user session → 跳 login
    if (!currentUser) {
      await showLicensePage();
      return;
    }
    // 2) 检查 license
    const params = new URLSearchParams({ userToken: currentUser.token, userEmail: currentUser.email });
    const response = await fetch(`${localApiBase}/license/status?${params.toString()}`, { signal: AbortSignal.timeout(3000) });
    const result = (await response.json()) as { data?: { active?: boolean } };
    if (!result.data?.active) await showLicensePage();
  } catch {
    // 页面切换或本地服务短暂未就绪时，下一个轮询周期会重试。
  }
}

function createMainWindow(): Promise<void> {
  return new Promise((resolve) => {
    const win = new BrowserWindow({
      width: 1000,
      height: 700,
      minWidth: 800,
      minHeight: 500,
      frame: false,
      show: false,
      autoHideMenuBar: true,
      resizable: true,
      thickFrame: true,
    });
    mainWindow = win;
    win.setMenuBarVisibility(false);
    win.removeMenu();

    win.on("closed", () => {
      if (licenseMonitor) clearInterval(licenseMonitor);
      licenseMonitor = undefined;
      mainWindow = null;
    });

    win.once("ready-to-show", () => {
      win.show();
      resolve();
    });

    void loadLocalAuth();
    licenseMonitor = setInterval(() => void checkLicenseAfterLogin(), 800);
    win.webContents.session.webRequest.onCompleted({ urls: [`${localApiBase}/*`] }, (details) => {
      if (details.statusCode === 402) void showLicensePage();
    });
  });
}

let closeServeFn: (() => Promise<void>) | undefined;

protocol.registerSchemesAsPrivileged([
  {
    scheme: "toonflow",
    privileges: {
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
    },
  },
]);

app.whenReady().then(async () => {
  try {
    // 读 license server URL：dev 模式从环境变量读（tsx 不注入 esbuild define），prod 模式用编译期 define
    const runtimeLicenseUrl = (process.env.TOONFLOW_LICENSE_SERVER_URL ?? "").trim();
    const runtimePublicKey = (process.env.TOONFLOW_LICENSE_PUBLIC_KEY ?? "").trim().replace(/\\n/g, "\n");
    licenseServerUrl = runtimeLicenseUrl || (typeof __LICENSE_SERVER_URL__ === "string" ? __LICENSE_SERVER_URL__ : "");
    // 同步把运行时公钥灌到全局，client.ts 优先读 process.env
    if (runtimePublicKey) process.env.TOONFLOW_LICENSE_PUBLIC_KEY = runtimePublicKey;
    loadUserSession();
    let servePath: string;
    if (app.isPackaged) {
      // 生产环境：让出主线程一次，确保 loading 窗口渲染后再做耗时文件拷贝
      await new Promise((r) => setTimeout(r, 0));
      initializeData();
      servePath = path.join(app.getPath("userData"), "data", "serve", "app.js");
    } else {
      // 开发环境：直接加载源码（tsx 通过 -r tsx 注册了 require 钩子）
      servePath = path.join(process.cwd(), "src", "app.ts");
    }
    // 使用自定义路径加载模块
    const mod = requireWithCustomPaths(servePath);
    closeServeFn = mod.closeServe;
    const port = await mod.default(true);
    process.env.PORT = port;
    localApiBase = process.env.URL ?? `http://127.0.0.1:${port}/api`;
    await new Promise<void>((resolve, reject) => {
      setTimeout(() => {
        resolve();
      }, 2000);
    });
    // 注册协议处理器
    protocol.handle("toonflow", async (request) => {
      const url = new URL(request.url);
      const pathname = url.hostname.toLowerCase();
      const handlers: Record<string, () => object | Promise<object>> = {
        getappurl: () => ({ url: localApiBase }),
        getlicenseurl: () => ({ url: licenseServerUrl }),
        getusersession: () => {
          if (!currentUser) return { id: null };
          return { id: currentUser.id, email: currentUser.email, displayName: currentUser.displayName, token: currentUser.token };
        },
        proxyregister: async () => {
          if (!licenseServerUrl) return { ok: false, error: "授权服务未配置" };
          let body: { email?: string; password?: string; displayName?: string } = {};
          try {
            const text = url.searchParams.get("body") ?? "";
            body = JSON.parse(Buffer.from(text, "base64").toString("utf8"));
          } catch {
            return { ok: false, error: "请求体无效" };
          }
          try {
            const r = await fetch(`${licenseServerUrl}/api/v1/auth/register`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ email: body.email, password: body.password, displayName: body.displayName ?? "" }),
            });
            const data = (await r.json().catch(() => ({}))) as { code?: number; data?: { id: string; email: string; displayName?: string }; message?: string };
            if (!r.ok || !data?.data?.id) return { ok: false, error: data.message || "注册失败" };
            // 从 Set-Cookie 抠出 user session
            const setCookie = r.headers.get("set-cookie") ?? "";
            const match = setCookie.match(/toonflow_user=([^;]+)/);
            if (!match) return { ok: false, error: "服务器未返回会话" };
            const token = decodeURIComponent(match[1]);
            saveUserSession({ id: data.data.id, email: data.data.email, displayName: data.data.displayName ?? "", token, expiresAt: Date.now() + 8 * 60 * 60 * 1000 });
            return { ok: true, user: currentUser };
          } catch (e) {
            return { ok: false, error: e instanceof Error ? e.message : "网络错误" };
          }
        },
        proxylogin: async () => {
          if (!licenseServerUrl) return { ok: false, error: "授权服务未配置" };
          let body: { email?: string; password?: string } = {};
          try {
            const text = url.searchParams.get("body") ?? "";
            body = JSON.parse(Buffer.from(text, "base64").toString("utf8"));
          } catch {
            return { ok: false, error: "请求体无效" };
          }
          try {
            const r = await fetch(`${licenseServerUrl}/api/v1/auth/login`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ email: body.email, password: body.password }),
            });
            const data = (await r.json().catch(() => ({}))) as { code?: number; data?: { id: string; email: string; displayName?: string }; message?: string };
            if (!r.ok || !data?.data?.id) return { ok: false, error: data.message || "登录失败" };
            const setCookie = r.headers.get("set-cookie") ?? "";
            const match = setCookie.match(/toonflow_user=([^;]+)/);
            if (!match) return { ok: false, error: "服务器未返回会话" };
            const token = decodeURIComponent(match[1]);
            saveUserSession({ id: data.data.id, email: data.data.email, displayName: data.data.displayName ?? "", token, expiresAt: Date.now() + 8 * 60 * 60 * 1000 });
            return { ok: true, user: currentUser };
          } catch (e) {
            return { ok: false, error: e instanceof Error ? e.message : "网络错误" };
          }
        },
        clearsession: () => {
          saveUserSession(null);
          return { ok: true };
        },
        needauth: () => {
          void showLicensePage();
          return { ok: true };
        },
        authok: () => {
          // 登录/注册成功 → 立即进入激活页
          void showLicensePage();
          return { ok: true };
        },
        localauthok: () => {
          // 本地账号登录/注册成功 → 直接进授权验证页（license.html）
          // 不走 showLicensePage()，因为此时 currentUser 为 null，
          // showLicensePage 会错误加载 login.html（云授权登录页）
          mainWindow?.loadFile(getWebFile("license.html"));
          return { ok: true };
        },
        licenseactivated: () => {
          void loadMainContent();
          return { ok: true };
        },
        windowminimize: () => {
          mainWindow?.minimize();
          return { ok: true };
        },
        windowmaximize: () => {
          if (mainWindow?.isMaximized()) {
            mainWindow.unmaximize();
          } else {
            mainWindow?.maximize();
          }
          return { ok: true };
        },
        windowclose: () => {
          app.exit(0);
          return { ok: true };
        },
        apprestart: () => {
          // 延迟执行，让响应先返回给前端
          setTimeout(() => {
            app.relaunch();
            app.exit(0);
          }, 500);
          return { ok: true, message: "应用即将重启" };
        },
        windowismaximized: () => ({
          maximized: mainWindow?.isMaximized() ?? false,
        }),
        opendevtool: () => {
          mainWindow?.webContents.openDevTools();
          return { ok: true };
        },
        openurlwithbrowser: () => {
          const search = url.searchParams;
          const targetUrl = search.get("url");
          if (targetUrl) {
            const { shell } = require("electron");
            shell.openExternal(targetUrl);
            return { ok: true };
          } else {
            return { ok: false, error: "缺少url参数" };
          }
        },
        getlocallanguage: () => {
          // 获取应用区域设置

          // macOS系统特定方法
          if (process.platform === "darwin") {
            const systemLocale = systemPreferences.getUserDefault("AppleLocale", "string");
            return { ok: true, local: systemLocale };
          }
          const appLocale = app.getLocale();
          return { ok: true, local: appLocale };
        },
      };

      const handler = handlers[pathname];

      const responseData = await (handler ? handler() : { error: "未知接口" });
      return new Response(JSON.stringify(responseData), {
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        },
      });
    });

    // 服务启动成功，创建主窗口（主窗口 ready-to-show 时自动关闭loading）
    await createMainWindow();
  } catch (err) {
    console.error("[服务启动失败]:", err);
    await createMainWindow();
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createMainWindow();
  }
});

app.on("before-quit", async (event) => {
  if (closeServeFn) await closeServeFn();
});
