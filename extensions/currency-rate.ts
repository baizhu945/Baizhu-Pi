/**
 * Currency Rate Extension for Pi
 *
 * 实时获取 USD→CNY 汇率，写入 PI_USD_CNY_RATE 环境变量，
 * 供 cost-cny.patch（footer 人民币显示补丁）读取使用。
 *
 * 行为：
 *   - session 启动时立即抓取一次，之后每 6 小时刷新；
 *   - 抓取失败则 10 分钟后重试，并保留上一次的汇率。
 *
 * 数据源（免费、无需密钥，按顺序尝试）：
 *   1. open.er-api.com  （每日更新）
 *   2. api.frankfurter.app（ECB 汇率，工作日更新）
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const REFRESH_OK_MS = 6 * 60 * 60 * 1000; // 成功：6 小时后再刷新
const REFRESH_FAIL_MS = 10 * 60 * 1000; // 失败：10 分钟后重试

const SOURCES: Array<{
  url: string;
  extract: (json: Record<string, unknown>) => number | undefined;
}> = [
  {
    url: "https://open.er-api.com/v6/latest/USD",
    extract: (json) => {
      const rates = json.rates as Record<string, number> | undefined;
      return typeof rates?.CNY === "number" ? rates.CNY : undefined;
    },
  },
  {
    url: "https://api.frankfurter.app/latest?from=USD&to=CNY",
    extract: (json) => {
      const rates = json.rates as Record<string, number> | undefined;
      return typeof rates?.CNY === "number" ? rates.CNY : undefined;
    },
  },
];

async function fetchUsdCnyRate(): Promise<number | undefined> {
  for (const source of SOURCES) {
    try {
      const res = await fetch(source.url, { signal: AbortSignal.timeout(8_000) });
      if (!res.ok) continue;
      const rate = source.extract((await res.json()) as Record<string, unknown>);
      if (rate !== undefined && rate > 0) return rate;
    } catch {
      // 尝试下一个数据源
    }
  }
  return undefined;
}

export default function (pi: ExtensionAPI) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;

  async function refresh(): Promise<boolean> {
    const rate = await fetchUsdCnyRate();
    if (rate !== undefined) {
      // 与打补丁的 footer（cost-cny.patch）同进程，写入环境变量即可被读取
      process.env.PI_USD_CNY_RATE = rate.toFixed(4);
      return true;
    }
    return false;
  }

  async function tick(): Promise<void> {
    if (disposed) return;
    const ok = await refresh();
    if (disposed) return;
    timer = setTimeout(() => void tick(), ok ? REFRESH_OK_MS : REFRESH_FAIL_MS);
  }

  pi.on("session_start", () => {
    disposed = false;
    if (timer) clearTimeout(timer);
    void tick();
  });

  pi.on("session_shutdown", () => {
    disposed = true;
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
  });
}
