export interface Language {
  code: string;
  /** Name used in the UI. */
  label: string;
  /** Name used when instructing the model. */
  prompt: string;
}

export const TARGET_LANGUAGES: Language[] = [
  { code: 'en', label: 'English', prompt: 'English' },
  { code: 'es', label: 'Español', prompt: 'Spanish' },
  { code: 'es-419', label: 'Español (Latinoamérica)', prompt: 'Latin American Spanish' },
  { code: 'pt-BR', label: 'Português (Brasil)', prompt: 'Brazilian Portuguese' },
  { code: 'pt-PT', label: 'Português (Portugal)', prompt: 'European Portuguese' },
  { code: 'fr', label: 'Français', prompt: 'French' },
  { code: 'de', label: 'Deutsch', prompt: 'German' },
  { code: 'it', label: 'Italiano', prompt: 'Italian' },
  { code: 'nl', label: 'Nederlands', prompt: 'Dutch' },
  { code: 'pl', label: 'Polski', prompt: 'Polish' },
  { code: 'cs', label: 'Čeština', prompt: 'Czech' },
  { code: 'ro', label: 'Română', prompt: 'Romanian' },
  { code: 'hu', label: 'Magyar', prompt: 'Hungarian' },
  { code: 'sv', label: 'Svenska', prompt: 'Swedish' },
  { code: 'da', label: 'Dansk', prompt: 'Danish' },
  { code: 'nb', label: 'Norsk', prompt: 'Norwegian (Bokmål)' },
  { code: 'fi', label: 'Suomi', prompt: 'Finnish' },
  { code: 'el', label: 'Ελληνικά', prompt: 'Greek' },
  { code: 'tr', label: 'Türkçe', prompt: 'Turkish' },
  { code: 'ru', label: 'Русский', prompt: 'Russian' },
  { code: 'uk', label: 'Українська', prompt: 'Ukrainian' },
  { code: 'ar', label: 'العربية', prompt: 'Arabic' },
  { code: 'he', label: 'עברית', prompt: 'Hebrew' },
  { code: 'fa', label: 'فارسی', prompt: 'Persian' },
  { code: 'hi', label: 'हिन्दी', prompt: 'Hindi' },
  { code: 'bn', label: 'বাংলা', prompt: 'Bengali' },
  { code: 'id', label: 'Bahasa Indonesia', prompt: 'Indonesian' },
  { code: 'ms', label: 'Bahasa Melayu', prompt: 'Malay' },
  { code: 'fil', label: 'Filipino', prompt: 'Filipino (Tagalog)' },
  { code: 'vi', label: 'Tiếng Việt', prompt: 'Vietnamese' },
  { code: 'th', label: 'ไทย', prompt: 'Thai' },
  { code: 'ja', label: '日本語', prompt: 'Japanese' },
  { code: 'ko', label: '한국어', prompt: 'Korean' },
  { code: 'zh-CN', label: '简体中文', prompt: 'Simplified Chinese' },
  { code: 'zh-TW', label: '繁體中文', prompt: 'Traditional Chinese' },
];

export const SOURCE_LANGUAGES: Language[] = [
  { code: 'auto', label: 'Auto-detect', prompt: 'auto-detect (usually Japanese, Korean or Chinese)' },
  { code: 'ja', label: 'Japanese (manga)', prompt: 'Japanese' },
  { code: 'ko', label: 'Korean (manhwa / webtoon)', prompt: 'Korean' },
  { code: 'zh', label: 'Chinese (manhua)', prompt: 'Chinese' },
  { code: 'en', label: 'English (comics)', prompt: 'English' },
  { code: 'other', label: 'Other', prompt: 'any language' },
];

export function targetLanguage(code: string): Language {
  return TARGET_LANGUAGES.find((l) => l.code === code) ?? TARGET_LANGUAGES[0];
}

export function sourceLanguage(code: string): Language {
  return SOURCE_LANGUAGES.find((l) => l.code === code) ?? SOURCE_LANGUAGES[0];
}

/** Right-to-left scripts need the overlay text direction flipped. */
export function isRtl(code: string): boolean {
  return ['ar', 'he', 'fa'].includes(code);
}
