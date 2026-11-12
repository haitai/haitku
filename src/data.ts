/** 一段富文本，只保留影响观感的标记 */
export type Run = {
  t: string;
  b?: 1;
  i?: 1;
  c?: 1;
  s?: 1;
  u?: 1;
  hl?: 1;
  href?: string;
};

/** 正文块：动态里除了标题之外的内容（图片、段落、引用等） */
export type Block =
  | { k: 'p' | 'h1' | 'h2' | 'h3' | 'quote' | 'ul' | 'ol' | 'toggle'; r: Run[] }
  | { k: 'todo'; r: Run[]; done: 0 | 1 }
  | { k: 'code'; text: string; lang?: string }
  | { k: 'img'; src: string; w?: number; h?: number; alt?: string }
  | { k: 'link'; href: string; title: string }
  | { k: 'file'; href: string; name: string }
  | { k: 'hr' };

export type Post = {
  id: string;
  text: string;
  date: string;
  ts: number;
  blocks?: Block[];
  cover?: string;
  media?: number;
};

export type Payload = {
  updatedAt?: string;
  fetchedAt?: string;
  /** 实时接口本次返回的最早一条时间戳，用于识别窗口内的删除 */
  windowStart?: number;
  source?: string;
  total: number;
  withBody?: number;
  withImage?: number;
  media?: Record<string, string>;
  posts: Post[];
};

const sortDesc = (list: Post[]) => list.sort((a, b) => b.ts - a.ts);

/* ---------- 正文 ---------- */

export const runsText = (r?: Run[]) => (r ?? []).map((x) => x.t).join('');

export function blockText(b: Block): string {
  if (b.k === 'img' || b.k === 'hr') return '';
  if (b.k === 'code') return b.text;
  if (b.k === 'link') return b.title || b.href;
  if (b.k === 'file') return b.name || b.href;
  return runsText(b.r);
}

/** 标题 + 正文的纯文本，用于搜索 */
export const searchText = (p: Post) =>
  [p.text, ...(p.blocks ?? []).map(blockText)].join(' ').toLowerCase();

async function fetchJson(url: string, init?: RequestInit): Promise<Payload> {
  const res = await fetch(url, {
    headers: { accept: 'application/json' },
    ...init,
  });
  if (!res.ok) throw new Error(`${url} → ${res.status}`);
  const json = (await res.json()) as Payload;
  if (!json?.posts?.length) throw new Error(`${url} → 空数据`);
  return json;
}

/**
 * 静态快照是主体（全量、稳定），/api/posts 提供最新若干条，二者合并去重。
 * 任何一边失败都不影响页面可用。
 */
export async function loadPosts(): Promise<Payload> {
  const [snapshot, live] = await Promise.allSettled([
    fetchJson('/data/posts.json'),
    /* 实时接口不走浏览器 HTTP 缓存，发布新动态后刷新即可拿到最新数据 */
    fetchJson('/api/posts', { cache: 'no-store' }),
  ]);

  const base = snapshot.status === 'fulfilled' ? snapshot.value : null;
  const newest = live.status === 'fulfilled' ? live.value : null;

  if (!base && !newest) {
    const reason = snapshot.status === 'rejected' ? snapshot.reason : live.status === 'rejected' ? live.reason : null;
    throw reason instanceof Error ? reason : new Error('加载失败');
  }

  /* 实时接口按日期降序取回一个连续窗口。窗口内、但 Notion 已不再返回的条目
     视为删除/归档，从快照里剔除；窗口之外的老条目保留，交给每日全量同步处理。
     实时接口失败时不做任何剔除，避免误删。 */
  const liveIds = new Set((newest?.posts ?? []).map((p) => p.id));
  const windowStart = newest?.windowStart;
  const inLiveWindow = (p: Post) =>
    Boolean(newest) && typeof windowStart === 'number' && p.ts > windowStart;

  const map = new Map<string, Post>();
  for (const post of base?.posts ?? []) {
    if (inLiveWindow(post) && !liveIds.has(post.id)) continue;
    map.set(post.id, post);
  }

  /* 线上返回的图片是 Notion 代理地址，若本地已有缓存就换成本地文件 */
  const media = base?.media ?? {};
  const blockIdOf = /[?&]id=([0-9a-f-]{36})/i;
  const localize = (post: Post): Post => {
    if (!post.blocks?.length) return post;
    let changed = false;
    const blocks = post.blocks.map((b) => {
      if (b.k !== 'img') return b;
      const hit = blockIdOf.exec(b.src);
      const local = hit ? media[hit[1]] : undefined;
      if (!local) return b;
      changed = true;
      return { ...b, src: local };
    });
    if (!changed) return post;
    const imgs = blocks.filter((b): b is Extract<Block, { k: 'img' }> => b.k === 'img');
    return { ...post, blocks, cover: imgs[0]?.src, media: imgs.length };
  };

  for (const post of newest?.posts ?? []) map.set(post.id, localize(post));

  return {
    /* 实时接口返回的是 Notion 数据源最后变更时间，优先采用。
       静态快照的 updatedAt 只是构建时刻，仅在实时接口失败时兜底。 */
    updatedAt: newest?.updatedAt ?? base?.updatedAt,
    source: base?.source ?? newest?.source,
    total: map.size,
    posts: sortDesc([...map.values()]),
  };
}

/* ---------- 日期 ---------- */

export function parts(date: string) {
  const [d, t = '00:00'] = date.split('T');
  const [y, m, day] = d.split('-').map(Number);
  const [hh, mm] = t.split(':').map(Number);
  return { y, m, d: day, hh, mm };
}

export const dayLabel = (date: string) => {
  const { m, d } = parts(date);
  return `${m}月${d}日`;
};

export const timeLabel = (date: string) => {
  const { hh, mm } = parts(date);
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
};

export const yearOf = (date: string) => Number(date.slice(0, 4));

const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

export const weekdayLabel = (date: string) => {
  const { y, m, d, hh, mm } = parts(date);
  const dt = new Date(Date.UTC(y, m - 1, d, hh - 8, mm));
  return WEEK[dt.getUTCDay()];
};

export const fullLabel = (date: string) => {
  const { y } = parts(date);
  return `${y} 年 ${dayLabel(date)} ${timeLabel(date)} · ${weekdayLabel(date)}`;
};

export const nf = new Intl.NumberFormat('zh-CN');
