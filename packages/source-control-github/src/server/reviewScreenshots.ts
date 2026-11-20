import { coordinatorWebUrl } from "@t3tools/contracts";

// Recognize labeled PR images, including the common two-column comparison table.
export function reviewScreenshots(body: string) {
  const result: { before: string | null; after: string | null } = { before: null, after: null };
  let section: "before" | "after" | null = null;
  let table: readonly ("before" | "after")[] = [];
  for (const line of body.split(/\r?\n/)) {
    const columns = line
      .split("|")
      .map((c) => c.trim().toLowerCase())
      .filter(Boolean);
    if (columns.length === 2 && columns.includes("before") && columns.includes("after")) {
      table = columns[0] === "before" ? ["before", "after"] : ["after", "before"];
      section = null;
      continue;
    }
    if (table.length && /^\s*\|?\s*:?-{2,}/.test(line)) continue;
    const heading = /^\s*(?:#{1,6}\s*|\*\*)?(before|after)\b/i.exec(line);
    if (heading) section = heading[1]!.toLowerCase() === "before" ? "before" : "after";
    else if (/^\s*#/.test(line)) section = null;
    const images = Array.from(
      line.matchAll(/!\[([^\]]*)\]\((https:\/\/[^\s)]+)\)|(<img\b[^>]*>)/gi),
    );
    for (const [index, image] of images.entries()) {
      const tag = image[3] ?? "";
      const label = image[1] ?? /\balt=["']([^"']*)/i.exec(tag)?.[1] ?? "";
      const kind = /\bbefore\b/i.test(label)
        ? "before"
        : /\bafter\b/i.test(label)
          ? "after"
          : (table[index] ?? section);
      if (kind && !result[kind])
        result[kind] = coordinatorWebUrl(image[2] ?? /\bsrc=["']([^"']*)/i.exec(tag)?.[1]);
    }
    if (images.length || (table.length && line.trim())) table = [];
  }
  return result;
}
