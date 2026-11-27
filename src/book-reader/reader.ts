import './reader.css';
import { bindReaderPinch, clampReaderZoom, MAX_READER_ZOOM, readerZoomOffset, type ZoomPoint } from '../../services/readerPinch';

const pages = document.querySelector<HTMLElement>('#pages')!;
const previous = document.querySelector<HTMLButtonElement>('#previous')!;
const next = document.querySelector<HTMLButtonElement>('#next')!;
const position = document.querySelector<HTMLElement>('#position')!;
const zoomControls = document.querySelector<HTMLElement>('#zoom-controls')!;
const zoomOut = document.querySelector<HTMLButtonElement>('#zoom-out')!;
const zoomReset = document.querySelector<HTMLButtonElement>('#zoom-reset')!;
const zoomIn = document.querySelector<HTMLButtonElement>('#zoom-in')!;
const params = new URLSearchParams(location.hash.slice(1));
const format = params.get('format');
const digest = params.get('id');
const storageKey = `praha.book-reader.${digest}`;

function readPosition() {
  try { return localStorage.getItem(storageKey); } catch { return null; }
}

function savePosition(value: string) {
  try { localStorage.setItem(storageKey, value); } catch { /* storage is optional */ }
}

function showError() {
  position.textContent = 'This book couldn’t be opened. Go back and try another file.';
  previous.disabled = next.disabled = true;
  zoomControls.hidden = true;
}

function enableZoom(applyZoom: (next: number, current: number, point?: ZoomPoint) => void) {
  let zoom = 1;
  const changeZoom = (value: number, point?: ZoomPoint) => {
    const nextZoom = clampReaderZoom(value);
    if (nextZoom === zoom) return;
    applyZoom(nextZoom, zoom, point);
    zoom = nextZoom;
    zoomReset.textContent = `${Math.round(zoom * 100)}%`;
    zoomReset.disabled = zoomOut.disabled = zoom === 1;
    zoomIn.disabled = zoom === MAX_READER_ZOOM;
  };
  zoomOut.onclick = () => changeZoom(zoom - 0.25);
  zoomReset.onclick = () => changeZoom(1);
  zoomIn.onclick = () => changeZoom(zoom + 0.25);
  zoomControls.hidden = false;
  return { changeZoom, getZoom: () => zoom };
}

function enablePageZoom() {
  pages.classList.add('image-pages');
  const { changeZoom, getZoom } = enableZoom((zoom, previousZoom, point) => {
    const { left, top } = readerZoomOffset(pages, previousZoom, zoom, point);
    pages.style.setProperty('--reader-zoom', String(zoom));
    pages.scrollLeft = left;
    pages.scrollTop = top;
  });
  bindReaderPinch(pages, getZoom, changeZoom);
}

function createPageStage() {
  const stage = document.createElement('div');
  stage.className = 'page-stage';
  pages.append(stage);
  return stage;
}

async function readPdf() {
  const [{ getDocument, GlobalWorkerOptions, PDFDataRangeTransport }, { default: worker }] = await Promise.all([
    import('pdfjs-dist/legacy/build/pdf.mjs'),
    import('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url'),
  ]);
  GlobalWorkerOptions.workerSrc = worker;
  const assets = new URL('/assets/pdfjs/', location.origin).href;
  const rangeUrl = (start: number, end: number) => `/document/book?range=bytes=${start}-${end - 1}`;
  const initial = await fetch(rangeUrl(0, 65536));
  const length = Number(initial.headers.get('Content-Range')?.split('/')[1]);
  if (initial.status !== 206 || !Number.isSafeInteger(length) || length < 1) throw new Error('Invalid PDF length');
  const abort = new AbortController();
  class LocalPdfRange extends PDFDataRangeTransport {
    requestDataRange(begin: number, end: number) {
      void fetch(rangeUrl(begin, end), { signal: abort.signal })
        .then(async (response) => {
          if (response.status !== 206) throw new Error('PDF data unavailable');
          const bytes = new Uint8Array(await response.arrayBuffer());
          if (bytes.length !== end - begin) throw new Error('Incomplete PDF data');
          this.onDataRange(begin, bytes);
        })
        .catch(() => {
          if (!abort.signal.aborted) {
            showError();
            void task.destroy().catch(() => undefined);
          }
        });
    }
    abort() { abort.abort(); }
  }

  const range = new LocalPdfRange(length, new Uint8Array(await initial.arrayBuffer()));
  const task = getDocument({
    range,
    disableAutoFetch: true,
    disableStream: true,
    cMapUrl: `${assets}cmaps/`,
    standardFontDataUrl: `${assets}standard_fonts/`,
    iccUrl: `${assets}iccs/`,
    wasmUrl: `${assets}wasm/`,
  });
  const pdf = await task.promise;
  const resume = Number(readPosition());
  let number = Number.isInteger(resume) ? Math.min(Math.max(resume, 1), pdf.numPages) : 1;
  const canvas = document.createElement('canvas');
  createPageStage().append(canvas);

  async function render(numberToRead: number) {
    previous.disabled = next.disabled = true;
    const page = await pdf.getPage(numberToRead);
    try {
      const size = page.getViewport({ scale: 1 });
      const scale = Math.min(
        pages.clientWidth * Math.min(devicePixelRatio, 3) / size.width,
        Math.sqrt(4_000_000 / (size.width * size.height)),
      );
      const viewport = page.getViewport({ scale });
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      await page.render({ canvas, viewport }).promise;
      pages.scrollTop = 0;
      number = numberToRead;
      position.textContent = `Page ${number} of ${pdf.numPages}`;
      previous.disabled = number <= 1;
      next.disabled = number >= pdf.numPages;
      savePosition(String(number));
    } finally {
      page.cleanup();
    }
  }

  previous.onclick = () => void render(number - 1).catch(showError);
  next.onclick = () => void render(number + 1).catch(showError);
  enablePageZoom();
  await render(number);
}

async function readEpub(data: ArrayBuffer) {
  const { default: ePub } = await import('epubjs');
  pages.classList.add('epub');
  const book = ePub({ replacements: 'blobUrl' });
  await book.open(data);
  await book.opened;
  // Some EPUBs list an optional cover without a matching manifest entry.
  book.spine.each((section: import('epubjs/types/section').default) => {
    if (!section.url) section.linear = false;
  });
  const rendition = book.renderTo(pages, {
    width: '100%',
    height: '100%',
    flow: 'paginated',
    spread: 'none',
    allowScriptedContent: false,
  });
  rendition.on('relocated', (location: import('epubjs/types/rendition').Location) => {
    const { index, displayed, cfi } = location.start;
    position.textContent = `Section ${index + 1} · Page ${displayed.page} of ${displayed.total}`;
    previous.disabled = location.atStart;
    next.disabled = location.atEnd;
    if (cfi) savePosition(cfi);
  });
  previous.onclick = () => void rendition.prev().catch(showError);
  next.onclick = () => void rendition.next().catch(showError);
  const resume = readPosition();
  if (resume?.startsWith('epubcfi(') && book.spine.get(resume)?.url) await rendition.display(resume).catch(() => rendition.display());
  else await rendition.display();
  enableZoom((zoom) => rendition.themes.fontSize(`${zoom * 100}%`));
}

async function readComic() {
  const response = await fetch('/document/pages');
  if (!response.ok) throw new Error('Comic unavailable');
  const names: string[] = await response.json();
  const images = names.map((name, index) => ({ name, index }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  if (!images.length) throw new Error('Comic has no images');

  const saved = Number(readPosition());
  let index = Number.isInteger(saved) ? Math.min(Math.max(saved, 0), images.length - 1) : 0;
  const stage = createPageStage();
  let prefetched: { page: number; image: HTMLImageElement } | undefined;
  const loadImage = (page: number) => {
    const image = new Image();
    image.src = `/document/page/${images[page].index}`;
    return image;
  };
  async function render(page: number) {
    previous.disabled = next.disabled = true;
    const image = prefetched?.page === page ? prefetched.image : loadImage(page);
    await image.decode();
    index = page;
    image.alt = `Page ${index + 1}`;
    stage.replaceChildren(image);
    pages.scrollTop = 0;
    position.textContent = `Page ${index + 1} of ${images.length}`;
    previous.disabled = index === 0;
    next.disabled = index === images.length - 1;
    savePosition(String(index));
    const following = page + 1 < images.length ? page + 1 : page - 1;
    prefetched = following >= 0 ? { page: following, image: loadImage(following) } : undefined;
    void prefetched?.image.decode().catch(() => undefined);
  }
  const turnPage = (page: number) => {
    void render(page).catch(() => {
      prefetched = undefined;
      position.textContent = `Page ${page + 1} failed. Try again.`;
      previous.disabled = index === 0;
      next.disabled = index === images.length - 1;
    });
  };
  previous.onclick = () => turnPage(index - 1);
  next.onclick = () => turnPage(index + 1);
  enablePageZoom();
  await render(index);
}

async function openBook() {
  if (!digest || !/^[a-f0-9]{64}$/.test(digest) || (format !== 'pdf' && format !== 'epub' && format !== 'cbz')) throw new Error('Invalid book');
  if (format === 'pdf') return readPdf();
  if (format === 'cbz') return readComic();
  const response = await fetch('/document/book');
  if (!response.ok) throw new Error('Book unavailable');
  await readEpub(await response.arrayBuffer());
}

void openBook().catch(showError);
