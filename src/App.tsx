import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  dayLabel,
  fullLabel,
  loadPosts,
  nf,
  searchText,
  timeLabel,
  yearOf,
  type Block,
  type Payload,
  type Post,
  type Run,
} from './data';

const PAGE = 60;

/* 搜索语法：y:2026 限定年份，has:image 只看有图，其余词按全文关键词处理 */
type ParsedQuery = { keyword: string; year: number | 'all'; mediaOnly: boolean };

function parseQuery(raw: string): ParsedQuery {
  let year: number | 'all' = 'all';
  let mediaOnly = false;
  const words: string[] = [];
  for (const token of raw.trim().split(/\s+/)) {
    if (!token) continue;
    const y = /^y:(\d{4})$/i.exec(token);
    if (y) {
      year = Number(y[1]);
      continue;
    }
    if (/^has:image$/i.test(token)) {
      mediaOnly = true;
      continue;
    }
    words.push(token);
  }
  return { keyword: words.join(' '), year, mediaOnly };
}

/* ---------------------------------- 图标 --------------------------------- */

const Mark = () => (
  <svg viewBox="0 0 32 32" width="30" height="30" aria-hidden="true">
    <rect width="32" height="32" rx="9" fill="#0d8ae0" />
    <path
      fill="#fff"
      transform="translate(4.5 5.5) scale(0.96)"
      d="M23.953 4.57a10 10 0 01-2.825.775 4.958 4.958 0 002.163-2.723c-.951.555-2.005.959-3.127 1.184a4.92 4.92 0 00-8.384 4.482C7.69 8.095 4.067 6.13 1.64 3.162a4.822 4.822 0 00-.666 2.475c0 1.71.87 3.213 2.188 4.096a4.904 4.904 0 01-2.228-.616v.06a4.923 4.923 0 003.946 4.827 4.996 4.996 0 01-2.212.085 4.936 4.936 0 004.604 3.417 9.867 9.867 0 01-6.102 2.105c-.39 0-.779-.023-1.17-.067a13.995 13.995 0 007.557 2.209c9.053 0 13.998-7.496 13.998-13.985 0-.21 0-.42-.015-.63A9.935 9.935 0 0024 4.59z"
    />
  </svg>
);

const Ico = {
  search: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.6-3.6" strokeLinecap="round" />
    </svg>
  ),
  x: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <path d="m6 6 12 12M18 6 6 18" strokeLinecap="round" />
    </svg>
  ),
  copy: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
      <rect x="9" y="9" width="11" height="11" rx="2.5" />
      <path d="M15 5.5A2.5 2.5 0 0 0 12.5 3h-7A2.5 2.5 0 0 0 3 5.5v7A2.5 2.5 0 0 0 5.5 15" />
    </svg>
  ),
  external: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
      <path d="M14 4h6v6M20 4l-9 9" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M18 14v4.5A1.5 1.5 0 0 1 16.5 20h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H10" />
    </svg>
  ),
  sun: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M19.1 4.9l-1.8 1.8M6.7 17.3l-1.8 1.8" strokeLinecap="round" />
    </svg>
  ),
  moon: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
      <path d="M20 14.5A8.5 8.5 0 0 1 9.5 4 8.5 8.5 0 1 0 20 14.5Z" strokeLinejoin="round" />
    </svg>
  ),
  up: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <path d="M12 19V5M6 11l6-6 6 6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
};

/* --------------------------------- 文本渲染 -------------------------------- */

function markify(text: string, q: string, prefix: string): ReactNode[] {
  if (!q) return [text];
  const lower = text.toLowerCase();
  const needle = q.toLowerCase();
  const nodes: ReactNode[] = [];
  let from = 0;
  let i = lower.indexOf(needle);
  while (i !== -1) {
    if (i > from) nodes.push(text.slice(from, i));
    nodes.push(<mark key={`${prefix}-${i}`}>{text.slice(i, i + needle.length)}</mark>);
    from = i + needle.length;
    i = lower.indexOf(needle, from);
  }
  if (from < text.length) nodes.push(text.slice(from));
  return nodes;
}

function richText(text: string, q: string): ReactNode[] {
  const urlRe = /https?:\/\/[^\s，。；、）)】」]+/gi;
  const nodes: ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;

  while ((m = urlRe.exec(text))) {
    if (m.index > last) nodes.push(...markify(text.slice(last, m.index), q, `t${k}`));
    const url = m[0];
    nodes.push(
      <a
        key={`a${k}`}
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="post__link"
        onClick={(e) => e.stopPropagation()}
      >
        {url.replace(/^https?:\/\//, '')}
      </a>
    );
    last = m.index + url.length;
    k += 1;
  }
  if (last < text.length) nodes.push(...markify(text.slice(last), q, `t${k}`));
  return nodes;
}

/* -------------------------------- 正文渲染 -------------------------------- */

const markClass = (run: Run) =>
  [
    run.b ? 'is-b' : '',
    run.i ? 'is-i' : '',
    run.s ? 'is-s' : '',
    run.u ? 'is-u' : '',
    run.hl ? 'is-hl' : '',
  ]
    .filter(Boolean)
    .join(' ');

function RunText({ r, q }: { r?: Run[]; q: string }) {
  if (!r?.length) return null;
  return (
    <>
      {r.map((run, i) => {
        let node: ReactNode = q ? markify(run.t, q, `r${i}`) : run.t;
        if (run.c) node = <code className="body__code">{node}</code>;
        const cls = markClass(run);
        if (cls) node = <span className={cls}>{node}</span>;
        if (run.href) {
          node = (
            <a
              className="post__link"
              href={run.href}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
            >
              {node}
            </a>
          );
        }
        return <span key={i}>{node}</span>;
      })}
    </>
  );
}

function Figure({ block, compact }: { block: Extract<Block, { k: 'img' }>; compact: boolean }) {
  return (
    <figure className={`fig${compact ? ' fig--compact' : ''}`}>
      <a
        href={block.src}
        target="_blank"
        rel="noopener noreferrer"
        onClick={(e) => e.stopPropagation()}
      >
        <img
          src={block.src}
          alt={block.alt && !/\.(png|jpe?g|gif|webp)$/i.test(block.alt) ? block.alt : '配图'}
          width={block.w}
          height={block.h}
          loading="lazy"
          decoding="async"
        />
      </a>
    </figure>
  );
}

/** 正文块渲染；compact 用于列表卡片，只做轻量预览 */
function Body({ blocks, q, compact = false }: { blocks: Block[]; q: string; compact?: boolean }) {
  let num = 0;
  return (
    <div className={`body${compact ? ' body--compact' : ''}`}>
      {blocks.map((b, i) => {
        if (b.k !== 'ol') num = 0;
        switch (b.k) {
          case 'img':
            return <Figure key={i} block={b} compact={compact} />;
          case 'hr':
            return <hr key={i} className="body__hr" />;
          case 'code':
            return (
              <pre key={i} className="body__pre">
                <code>{b.text}</code>
              </pre>
            );
          case 'link':
          case 'file':
            return (
              <a
                key={i}
                className="body__link"
                href={b.href}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => e.stopPropagation()}
              >
                <span className="body__link-label">{b.k === 'link' ? b.title : b.name}</span>
                <span className="body__link-host">
                  {b.href.replace(/^https?:\/\//, '').split('/')[0]}
                </span>
              </a>
            );
          case 'h1':
          case 'h2':
          case 'h3':
            return (
              <p key={i} className={`body__h body__h--${b.k}`}>
                <RunText r={b.r} q={q} />
              </p>
            );
          case 'quote':
            return (
              <blockquote key={i} className="body__quote">
                <RunText r={b.r} q={q} />
              </blockquote>
            );
          case 'ul':
            return (
              <p key={i} className="body__li">
                <span className="body__bullet" aria-hidden="true" />
                <span>
                  <RunText r={b.r} q={q} />
                </span>
              </p>
            );
          case 'ol':
            num += 1;
            return (
              <p key={i} className="body__li body__li--num">
                <span className="body__num" aria-hidden="true">
                  {num}
                </span>
                <span>
                  <RunText r={b.r} q={q} />
                </span>
              </p>
            );
          case 'todo':
            return (
              <p key={i} className={`body__li body__todo${b.done ? ' is-done' : ''}`}>
                <span className="body__check" aria-hidden="true">
                  {b.done ? '✓' : ''}
                </span>
                <span>
                  <RunText r={b.r} q={q} />
                </span>
              </p>
            );
          case 'toggle':
            return (
              <p key={i} className="body__h body__h--h3">
                <RunText r={b.r} q={q} />
              </p>
            );
          default:
            return (
              <p key={i} className="body__p">
                <RunText r={b.r} q={q} />
              </p>
            );
        }
      })}
    </div>
  );
}

/* --------------------------------- 单个动态 -------------------------------- */

const permalink = (id: string) => `${location.origin}${location.pathname}#p=${id}`;

function PostCard({
  post,
  q,
  onOpen,
  onCopy,
}: {
  post: Post;
  q: string;
  onOpen: (p: Post) => void;
  onCopy: (p: Post) => void;
}) {
  return (
    <article
      className="post"
      onClick={() => onOpen(post)}
      tabIndex={0}
      role="button"
      aria-label={`打开 ${post.date} 的动态`}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen(post);
        }
      }}
    >
      <div className="post__meta">
        <span className="post__day">{dayLabel(post.date)}</span>
        <span className="post__time">{timeLabel(post.date)}</span>
        {post.media ? <span className="post__media">{post.media} 图</span> : null}
      </div>
      <div className="post__main">
        {post.text && <p className="post__text">{richText(post.text, q)}</p>}
        {post.cover && (
          <div className="post__thumb">
            <img src={post.cover} alt="配图" loading="lazy" decoding="async" />
            <span className="post__thumb-hint">查看大图</span>
          </div>
        )}
        <div className="post__tools">
          <button
            type="button"
            className="tool"
            onClick={(e) => {
              e.stopPropagation();
              onCopy(post);
            }}
          >
            {Ico.copy}
            <span>复制链接</span>
          </button>
        </div>
      </div>
    </article>
  );
}

/* ---------------------------------- 应用 ---------------------------------- */

type Theme = 'light' | 'dark';

export default function App() {
  const [payload, setPayload] = useState<Payload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [visible, setVisible] = useState(PAGE);
  const [active, setActive] = useState<Post | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [theme, setTheme] = useState<Theme>(() => {
    const saved = localStorage.getItem('haitku-theme');
    if (saved === 'light' || saved === 'dark') return saved;
    return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  });
  const [showTop, setShowTop] = useState(false);

  const searchRef = useRef<HTMLInputElement>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);

  const deferredQuery = useDeferredValue(query.trim());
  const { keyword, year, mediaOnly } = useMemo(() => parseQuery(deferredQuery), [deferredQuery]);

  /* 记录工具条高度，供年份标题吸顶使用 */
  useEffect(() => {
    const el = toolbarRef.current;
    if (!el) return;
    const apply = () => document.documentElement.style.setProperty("--tb", `${el.offsetHeight}px`);
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    return () => ro.disconnect();
  }, [payload]);

  /* 主题 */
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('haitku-theme', theme);
  }, [theme]);

  /* 数据加载：首屏 + 切回页面时节流刷新（与 /api/posts 的 60 秒缓存对齐） */
  const lastLoadRef = useRef(0);
  const inFlightRef = useRef(false);

  const refresh = useCallback(async (initial = false) => {
    if (inFlightRef.current) return;
    if (!initial && Date.now() - lastLoadRef.current < 60_000) return;
    inFlightRef.current = true;
    try {
      const data = await loadPosts();
      lastLoadRef.current = Date.now();
      setPayload(data);
      setError(null);
      if (initial) {
        const hash = location.hash.match(/^#p=(.+)$/);
        if (hash) {
          const hit = data.posts.find((p) => p.id === hash[1]);
          if (hit) setActive(hit);
        }
      }
    } catch (err) {
      /* 已有数据时刷新失败不打断阅读，只在首屏展示错误 */
      if (initial || !lastLoadRef.current) setError((err as Error).message);
    } finally {
      inFlightRef.current = false;
    }
  }, []);

  /* 初始数据 + URL 参数（兼容旧的 ?y= / ?img= 深链，转成搜索语法） */
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const q0 = params.get('q') ?? '';
    const tokens = [q0];
    const y0 = params.get('y');
    if (y0 && /^\d{4}$/.test(y0) && !/y:\d{4}/i.test(q0)) tokens.push(`y:${y0}`);
    if (params.get('img') === '1' && !/has:image/i.test(q0)) tokens.push('has:image');
    const next = tokens.filter(Boolean).join(' ');
    if (next) setQuery(next);

    void refresh(true);
  }, [refresh]);

  /* 从别的标签页切回来 / 窗口重新获得焦点时，取一次最新动态 */
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    const onFocus = () => void refresh();
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onFocus);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onFocus);
    };
  }, [refresh]);

  /* 深链：弹窗打开时写入 hash */
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (active) {
      if (!dialog.open) {
        dialog.showModal();
        dialog.focus();
      }
      history.replaceState(null, '', `#p=${active.id}`);
    } else if (dialog.open) {
      dialog.close();
      history.replaceState(null, '', location.pathname + location.search);
    }
  }, [active]);

  /* URL 同步筛选条件：年份与「有图」已并入搜索串，旧的独立参数不再写入 */
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    if (query.trim()) params.set('q', query.trim());
    else params.delete('q');
    params.delete('y');
    params.delete('img');
    if (active) return;
    const next = params.toString();
    history.replaceState(null, '', `${location.pathname}${next ? `?${next}` : ''}${location.hash}`);
  }, [query, active]);

  /* 无限滚动 */
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) setVisible((v) => v + PAGE);
      },
      { rootMargin: '600px 0px' }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [payload]);

  /* 回到顶部按钮 */
  useEffect(() => {
    const onScroll = () => setShowTop(window.scrollY > 900);
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  const posts = payload?.posts ?? [];

  const filtered = useMemo(() => {
    const q = keyword.toLowerCase();
    return posts.filter((p) => {
      if (year !== 'all' && yearOf(p.date) !== year) return false;
      if (mediaOnly && !p.media) return false;
      if (!q) return true;
      return searchText(p).includes(q);
    });
  }, [posts, keyword, year, mediaOnly]);

  const groups = useMemo(() => {
    const out: { year: number; items: Post[] }[] = [];
    for (const post of filtered.slice(0, visible)) {
      const y = yearOf(post.date);
      const last = out[out.length - 1];
      if (last && last.year === y) last.items.push(post);
      else out.push({ year: y, items: [post] });
    }
    return out;
  }, [filtered, visible]);

  const resetVisible = useCallback(() => setVisible(PAGE), []);

  const onQuery = (v: string) => {
    setQuery(v);
    resetVisible();
  };

  const showToast = (msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast(null), 1800);
  };

  const copy = async (post: Post) => {
    try {
      await navigator.clipboard.writeText(permalink(post.id));
      showToast('链接已复制');
    } catch {
      showToast(permalink(post.id));
    }
  };

  const random = useCallback(() => {
    if (!filtered.length) return;
    setActive(filtered[Math.floor(Math.random() * filtered.length)]);
  }, [filtered]);

  /* 键盘：/ 聚焦搜索、r 随机看一条、Esc 退出搜索框 */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const el = e.target as HTMLElement;
      const typing = /^(INPUT|TEXTAREA)$/.test(el.tagName) || el.isContentEditable;
      if (e.key === 'Escape' && !active && document.activeElement === searchRef.current) {
        searchRef.current?.blur();
        return;
      }
      if (typing) return;
      if (e.key === '/') {
        e.preventDefault();
        searchRef.current?.focus();
      } else if (e.key === 'r' || e.key === 'R') {
        e.preventDefault();
        random();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active, random]);

  const step = (dir: 1 | -1) => {
    if (!active) return;
    const i = filtered.findIndex((p) => p.id === active.id);
    const next = filtered[i + dir];
    if (next) setActive(next);
  };

  const loading = !payload && !error;
  const filtering = Boolean(deferredQuery);

  return (
    <div className="app">
      <header className="hero">
        <div className="hero__art" aria-hidden="true" />
        <div className="hero__shade" aria-hidden="true" />
        <div className="wrap hero__inner">
          <nav className="hero__nav">
            <a className="brand" href="#top" aria-label="haitku 首页">
              <Mark />
              <span className="brand__name">haitku</span>
            </a>
          </nav>

          <div className="hero__copy">
            <h1 className="hero__title">haitku</h1>
            <p className="hero__desc">
              {loading
                ? '正在从 Notion 取回这些年的碎碎念…'
                : `从 2007 年写到今天，${nf.format(posts.length)} 条流水账都在这儿。`}
            </p>
          </div>
        </div>
      </header>

      <div className="toolbar" id="top" ref={toolbarRef}>
        <div className="wrap toolbar__inner">
          <label className="search">
            <span className="search__ico">{Ico.search}</span>
            <input
              ref={searchRef}
              value={query}
              onChange={(e) => onQuery(e.target.value)}
              placeholder="搜索"
              aria-label="搜索动态"
              spellCheck={false}
            />
            {query ? (
              <button
                type="button"
                className="search__clear"
                onClick={() => {
                  onQuery('');
                  searchRef.current?.focus();
                }}
                aria-label="清空搜索"
              >
                {Ico.x}
              </button>
            ) : (
              <kbd className="search__kbd">/</kbd>
            )}
            {!query && (
              <span className="search__hint" aria-hidden="true">
                <code>y:2026</code> 年份 · <code>has:image</code> 有图 · <kbd>r</kbd> 随机
              </span>
            )}
          </label>

          <div className="toolbar__side">
            <button
              type="button"
              className="iconbtn iconbtn--plain"
              onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
              aria-label={theme === 'dark' ? '切换到浅色模式' : '切换到深色模式'}
              title="切换主题"
            >
              {theme === 'dark' ? Ico.sun : Ico.moon}
            </button>
          </div>
        </div>
      </div>

      <main className="wrap main" id="feed">
        {filtering && !loading && (
          <div className="filterbar">
            <span>
              筛出 <b>{nf.format(filtered.length)}</b> 条
              {year !== 'all' && <> · {year} 年</>}
              {mediaOnly && <> · 只看有图</>}
              {keyword && (
                <>
                  {' '}
                  · 关键词 <b>“{keyword}”</b>
                </>
              )}
            </span>
            <button type="button" onClick={() => onQuery('')}>
              清除筛选
            </button>
          </div>
        )}

        {loading && (
          <div className="skeletons" aria-hidden="true">
            {Array.from({ length: 7 }).map((_, i) => (
              <div className="skeleton" key={i}>
                <div className="skeleton__date" />
                <div className="skeleton__lines">
                  <div style={{ width: `${88 - i * 7}%` }} />
                  <div style={{ width: `${46 + (i % 3) * 9}%` }} />
                </div>
              </div>
            ))}
          </div>
        )}

        {error && (
          <div className="state">
            <h2>没能取到内容</h2>
            <p>{error}</p>
            <button type="button" className="btn" onClick={() => location.reload()}>
              重试
            </button>
          </div>
        )}

        {!loading && !error && filtered.length === 0 && (
          <div className="state">
            <h2>没有匹配的动态</h2>
            <p>换个关键词试试，也可以用 y:2026 限定年份、has:image 只看有图。</p>
            <button type="button" className="btn" onClick={() => onQuery('')}>
              查看全部
            </button>
          </div>
        )}

        {groups.map((group) => (
          <section className="year" key={group.year}>
            <div className="year__head">
              <h2>{group.year}</h2>
              <span className="year__rule" />
            </div>
            <div className="year__list">
              {group.items.map((post) => (
                <PostCard key={post.id} post={post} q={keyword} onOpen={setActive} onCopy={copy} />
              ))}
            </div>
          </section>
        ))}

        {!loading && !error && filtered.length > 0 && (
          <>
            <div ref={sentinelRef} className="sentinel" />
            {visible < filtered.length ? (
              <button type="button" className="more" onClick={() => setVisible((v) => v + PAGE)}>
                继续往下看
                <span>
                  {nf.format(Math.min(visible, filtered.length))} / {nf.format(filtered.length)}
                </span>
              </button>
            ) : (
              <p className="end">— 到这儿就没了 —</p>
            )}
          </>
        )}
      </main>

      <footer className="footer">
        <div className="wrap footer__inner">
          {payload?.updatedAt && (
            <p className="footer__meta">
              数据更新于 {new Date(payload.updatedAt).toLocaleString('zh-CN', { hour12: false })}
            </p>
          )}
        </div>
      </footer>

      {showTop && (
        <button type="button" className="totop" onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })} aria-label="回到顶部">
          {Ico.up}
        </button>
      )}

      <dialog
        ref={dialogRef}
        className="sheet"
        onClose={() => setActive(null)}
        onClick={(e) => {
          if (e.target === dialogRef.current) setActive(null);
        }}
      >
        {active && (
          <div className="sheet__panel">
            <div className="sheet__head">
              <time>{fullLabel(active.date)}</time>
              <button type="button" className="iconbtn iconbtn--plain" onClick={() => setActive(null)} aria-label="关闭">
                {Ico.x}
              </button>
            </div>
            <div className="sheet__scroll">
              {active.text && <p className="sheet__text">{richText(active.text, '')}</p>}
              {active.blocks?.length ? <Body blocks={active.blocks} q="" /> : null}
            </div>
            <div className="sheet__foot">
              <button type="button" className="btn btn--ghost" onClick={() => copy(active)}>
                {Ico.copy}
                复制链接
              </button>
              <div className="sheet__nav">
                <button type="button" onClick={() => step(-1)} aria-label="上一条">
                  ←
                </button>
                <button type="button" onClick={() => step(1)} aria-label="下一条">
                  →
                </button>
              </div>
            </div>
          </div>
        )}
      </dialog>

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
