import './reader.css';

const pages = document.querySelector<HTMLElement>('#pages')!;
const previous = document.querySelector<HTMLButtonElement>('#previous')!;
const next = document.querySelector<HTMLButtonElement>('#next')!;
const position = document.querySelector<HTMLElement>('#position')!;
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
}

async function readPdf(data: ArrayBuffer) {
  const [{ getDocument, GlobalWorkerOptions }, { default: worker }] = await Promise.all([
    import('pdfjs-dist/legacy/build/pdf.mjs'),
    import('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url'),
  ]);
  GlobalWorkerOptions.workerSrc = worker;
  const assets = new URL('/assets/pdfjs/', location.origin).href;
  const pdf = await getDocument({
    data,
    cMapUrl: `${assets}cmaps/`,
    standardFontDataUrl: `${assets}standard_fonts/`,
    iccUrl: `${assets}iccs/`,
    wasmUrl: `${assets}wasm/`,
  }).promise;
  const resume = Number(readPosition());
  let number = Number.isInteger(resume) ? Math.min(Math.max(resume, 1), pdf.numPages) : 1;
  const canvas = document.createElement('canvas');
  pages.append(canvas);

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
  await render(number);
}

async function readEpub(data: ArrayBuffer) {
  const { default: ePub } = await import('epubjs');
  pages.classList.add('epub');
  const book = ePub({ replacements: 'blobUrl' });
  await book.open(data);
  await book.opened;
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
  if (resume?.startsWith('epubcfi(')) await rendition.display(resume).catch(() => rendition.display());
  else await rendition.display();
}

async function readComic(data: ArrayBuffer) {
  const { default: JSZip } = await import('jszip');
  const archive = await JSZip.loadAsync(data);
  const images = Object.values(archive.files)
    .filter((file) => !file.dir && !file.name.startsWith('__MACOSX/') && /\.(jpe?g|png|webp|gif|avif)$/i.test(file.name))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  if (!images.length) throw new Error('Comic has no images');

  const saved = Number(readPosition());
  let index = Number.isInteger(saved) ? Math.min(Math.max(saved, 0), images.length - 1) : 0;
  const image = document.createElement('img');
  pages.append(image);
  async function render(page: number) {
    previous.disabled = next.disabled = true;
    const blob = await images[page].async('blob');
    const oldUrl = image.src;
    image.src = URL.createObjectURL(blob);
    if (oldUrl) URL.revokeObjectURL(oldUrl);
    index = page;
    image.alt = `Page ${index + 1}`;
    pages.scrollTop = 0;
    position.textContent = `Page ${index + 1} of ${images.length}`;
    previous.disabled = index === 0;
    next.disabled = index === images.length - 1;
    savePosition(String(index));
  }
  previous.onclick = () => void render(index - 1).catch(showError);
  next.onclick = () => void render(index + 1).catch(showError);
  await render(index);
}

async function openBook() {
  if (!digest || !/^[a-f0-9]{64}$/.test(digest) || (format !== 'pdf' && format !== 'epub' && format !== 'cbz')) throw new Error('Invalid book');
  const response = await fetch('/document/book');
  if (!response.ok) throw new Error('Book unavailable');
  const data = await response.arrayBuffer();
  await (format === 'pdf' ? readPdf(data) : format === 'epub' ? readEpub(data) : readComic(data));
}

void openBook().catch(showError);
