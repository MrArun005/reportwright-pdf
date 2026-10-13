/** standard font name → file in ./fonts (for fetching in a browser) */
export const FILES: Record<string, string>;
/** the 14 standard fonts' bytes by name, for renderPage(doc, i, { fonts: stdFonts }) (Node) */
export const stdFonts: Record<string, Uint8Array>;
