(expectedUrl) => {
  if (location.origin + location.pathname !== expectedUrl) return null;
  const leaves = (root) => [...root.querySelectorAll('*')].filter((element) => !element.children.length);
  const heading = leaves(document.body).find((element) => element.textContent.trim() === 'Moctale Meter');
  const labels = ['Perfection', 'Go for it', 'Timepass', 'Skip'];
  let section = heading?.parentElement;
  for (let depth = 0; section && depth < 6; depth += 1, section = section.parentElement) {
    const text = leaves(section).map((element) => element.textContent.trim()).filter(Boolean)
      .join(' ').split('User Reviews', 1)[0];
    const buckets = labels.map((label) => {
      const match = text.match(new RegExp(`(?:^|\\s)${label}\\s+(<\\s*)?(\\d{1,3}(?:\\.\\d+)?)\\s*%`, 'i'));
      return { label, percent: match ? Number(match[2]) : NaN, lessThan: Boolean(match?.[1]) };
    });
    if (!buckets.every(({ percent }) => Number.isFinite(percent) && percent >= 0 && percent <= 100)) continue;
    const total = buckets.reduce((sum, { percent }) => sum + percent, 0);
    if (total < 96 || total > 104) continue;
    const summary = section.innerText.match(/Moctale Meter\s+(\d{1,3})\s*%\s+[\d,]+\s*\/\s*([\d,]+)\s+Votes/i);
    return {
      buckets, noReviews: /\bNo Reviews Yet\b/i.test(text),
      ...(summary && { score: Number(summary[1]), votes: Number(summary[2].replaceAll(',', '')) }),
    };
  }
  return null;
}
