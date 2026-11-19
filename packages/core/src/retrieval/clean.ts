/**
 * HTML -> readable text + links. The output is *content*: it is later wrapped
 * as untrusted data before any model sees it.
 */
import * as cheerio from 'cheerio';

export interface PageLink {
  url: string;
  text: string;
}

export interface CleanPage {
  title: string;
  siteName?: string;
  description?: string;
  text: string;
  links: PageLink[];
}

const BLOCK = 'p,div,section,article,li,ul,ol,h1,h2,h3,h4,h5,h6,br,tr,table,blockquote,pre,header,main,dd,dt';
const NOISE = 'script,style,noscript,svg,iframe,template,form,canvas,object,embed,button,select,input,textarea';
const CHROME = 'nav,footer,[role=navigation],[aria-hidden=true],.cookie,.cookies,#cookie-banner';

export function cleanHtml(html: string, baseUrl: string, maxChars = 20_000): CleanPage {
  const $ = cheerio.load(html);

  // Links first, including those in nav/footer, which is where hiring pages hide.
  const links: PageLink[] = [];
  const seen = new Set<string>();
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href')?.trim();
    if (!href || /^(mailto|tel|javascript|data):/i.test(href) || href.startsWith('#')) return;
    let abs: URL;
    try {
      abs = new URL(href, baseUrl);
    } catch {
      return;
    }
    if (abs.protocol !== 'http:' && abs.protocol !== 'https:') return;
    abs.hash = '';
    const text = ($(el).text() || $(el).attr('aria-label') || $(el).attr('title') || '').replace(/\s+/g, ' ').trim();
    if (seen.has(abs.href)) {
      const prev = links.find((l) => l.url === abs.href);
      if (prev && text && !prev.text.includes(text)) prev.text = `${prev.text} ${text}`.trim().slice(0, 200);
      return;
    }
    seen.add(abs.href);
    links.push({ url: abs.href, text: text.slice(0, 200) });
  });

  const title = ($('title').first().text() || $('h1').first().text()).replace(/\s+/g, ' ').trim();
  const siteName = $('meta[property="og:site_name"]').attr('content')?.trim() || undefined;
  const description =
    ($('meta[name="description"]').attr('content') || $('meta[property="og:description"]').attr('content'))?.trim() ||
    undefined;

  $(NOISE).remove();
  $(CHROME).remove();
  $('h1,h2,h3,h4').each((_, el) => {
    $(el).prepend('\n## ');
  });
  $('li').each((_, el) => {
    $(el).prepend('\n- ');
  });
  $(BLOCK).each((_, el) => {
    $(el).append('\n');
  });

  const main = $('main').first().text() || $('article').first().text();
  const raw = main && main.trim().length > 200 ? main : $('body').text() || $.root().text();
  return { title, siteName, description, text: normaliseText(raw).slice(0, maxChars), links };
}

export function normaliseText(s: string): string {
  return s
    .replace(/ /g, ' ')
    .split('\n')
    .map((l) => l.replace(/[ \t\f\v]+/g, ' ').trim())
    .filter((l, i, arr) => l !== '' || (i > 0 && arr[i - 1] !== ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Extract <loc> URLs from a sitemap (or sitemap index). */
export function parseSitemap(xml: string): string[] {
  const out: string[] = [];
  for (const m of xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)) out.push(m[1]!.replace(/&amp;/g, '&'));
  return out;
}
