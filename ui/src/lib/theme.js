export function applyTheme(theme) {
  try { localStorage.setItem("aws-theme", theme); } catch {}
  if (theme === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
}
