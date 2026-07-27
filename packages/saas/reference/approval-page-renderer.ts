export type ApprovalTemplateReader = (path: string, encoding: "utf-8") => Promise<string>;

export function escapeHtmlAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** Shared selection logic used by the reference server; reader injection makes fallback testable. */
export async function renderApprovalTemplate(options: {
  templatePath: string;
  userCode?: string;
  readTemplate: ApprovalTemplateReader;
  fallback: (userCode?: string) => string;
}): Promise<string> {
  try {
    const template = await options.readTemplate(options.templatePath, "utf-8");
    return options.userCode
      ? template.replaceAll("{{USER_CODE}}", escapeHtmlAttribute(options.userCode))
      : template;
  } catch {
    return options.fallback(options.userCode);
  }
}
