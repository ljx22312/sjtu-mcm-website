/**
 * 清洗课表中的 schedule 字段：
 * 原始数据用 ",," 拼接多段安排，段内还可能带零散逗号/空白。
 * 按 ",," 切段 → 去掉首尾空白和多余逗号 → 去空去重 → 返回多行数组。
 */
export function parseSchedule(raw: string | undefined | null): string[] {
  if (!raw) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const seg of raw.split(",,")) {
    const cleaned = seg
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .join("，")
      .replace(/^[，\s]+|[，\s]+$/g, "")
      .trim();
    if (cleaned && !seen.has(cleaned)) {
      seen.add(cleaned);
      result.push(cleaned);
    }
  }
  return result;
}

export function formatSchedule(raw: string | undefined | null): string {
  return parseSchedule(raw).join("\n");
}

export interface NewsItem {
  date: string;
  category: "award" | "notice" | "activity";
  title: string;
  summary: string;
  source_url: string;
  tags: string[];
  note?: string;
  pinned?: boolean;
}

export function sortNews(items: NewsItem[]): NewsItem[] {
  return [...items].sort((a, b) => {
    if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
    return b.date.localeCompare(a.date);
  });
}

export interface Competition {
  id: string;
  name: string;
  name_en?: string;
  abbr: string;
  tier: string;
  organizer: string;
  team_size: string;
  duration: string;
  months: number[];
  reg_window: string;
  contest_window: string;
  level: string;
  url: string;
  url_reg?: string;
  status: "normal" | "paused" | "tbc";
  notes?: string;
}

/** 当前月份（构建时）前后各 2 个月（含当月，共 5 个月窗口，跨年循环）内的赛事 */
export function recentCompetitions(comps: Competition[], now = new Date()): Competition[] {
  const m = now.getMonth() + 1;
  const window = new Set<number>();
  for (let d = -2; d <= 2; d++) {
    window.add(((m - 1 + d + 12) % 12) + 1);
  }
  return comps
    .filter((c) => c.months.some((month) => window.has(month)))
    .sort((a, b) => {
      const dist = (months: number[]) =>
        Math.min(...months.map((month) => ((month - m + 12) % 12)));
      return dist(a.months) - dist(b.months);
    });
}

export const tierLabels: Record<string, string> = {
  core: "核心赛事",
  practice: "练兵赛事",
  research: "研究型赛事",
};

export const statusLabels: Record<string, string> = {
  normal: "正常举办",
  paused: "2026 暂停",
  tbc: "时间待确认",
};
