import { maxLength } from 'class-validator';
import { ManagedUnprocessableException } from '@gitroom/nestjs-libraries/database/prisma/managed/managed.errors';

// The exact plain text a provider has to receive for a managed caption, read
// back from content W&W stored with one of the codecs GET /capabilities
// declares (canonical.caption.vectors.json). Strict: the content must be
// exactly what the codec makes from some plain text, or it is refused.
// Nothing is guessed, repaired or decoded twice. The upstream converter
// (stripHtmlValidation) is not used here and is not changed by it.

export type ManagedCaptionCodec =
  | 'ww-plain-escape-v1'
  | 'ww-plain-paragraph-escape-v1';

export const MANAGED_CAPTION_CODECS: readonly ManagedCaptionCodec[] = [
  'ww-plain-escape-v1',
  'ww-plain-paragraph-escape-v1',
];

// Publication uses the draft DTO's character measure plus the separate hard
// code-unit bound below. Publication is deliberately narrower than legacy
// DRAFT storage; lifecycle preview and admission must enforce these rules.
export const MANAGED_PUBLICATION_TEXT_MAX_LENGTH = 100000;

// that measure does not count surrogate pairs or U+FE0E / U+FE0F, so it does
// not bound the size on its own. This hard bound in UTF-16 code units is
// checked first; three units per counted character still fits an astral
// emoji followed by a variation selector
export const MANAGED_PUBLICATION_TEXT_MAX_CODE_UNITS =
  3 * MANAGED_PUBLICATION_TEXT_MAX_LENGTH;

/** Separate lifecycle-publication policy; the legacy DRAFT v2 contract stays unchanged. */
export const MANAGED_PUBLICATION_TEXT_RULES = Object.freeze({
  version: 'ww-managed-publication-text-v1',
  codecs: MANAGED_CAPTION_CODECS,
  editors: ['normal'] as const,
  entities: ['&amp;', '&lt;', '&gt;', '&nbsp;'] as const,
  decoding: 'ONE_PASS_CANONICAL_ROUND_TRIP',
  refusedInput: ['C0_EXCEPT_LF_TAB', 'DEL', 'C1', 'U+2028', 'U+2029', 'LONE_SURROGATE'] as const,
  characterMeasure: 'CLASS_VALIDATOR_MAX_LENGTH',
  maxCharacters: MANAGED_PUBLICATION_TEXT_MAX_LENGTH,
  maxUtf16CodeUnits: MANAGED_PUBLICATION_TEXT_MAX_CODE_UNITS,
  legacyDraftAcceptanceDoesNotQualifyPublication: true,
} as const);

export type ManagedPublicationTextRefusal =
  | 'CODEC_NOT_SUPPORTED'
  | 'EDITOR_NOT_SUPPORTED'
  | 'CONTENT_NOT_STRING'
  | 'CONTENT_TOO_LONG'
  | 'WRAPPER_INVALID'
  | 'RAW_ANGLE_BRACKET'
  | 'RAW_NO_BREAK_SPACE'
  | 'ENTITY_NOT_CANONICAL'
  | 'UNREPRESENTABLE_CODE_POINT'
  | 'ROUND_TRIP_MISMATCH';

// the existing CONTENT_NOT_CANONICAL refusal, with the reason it was refused;
// the message never holds any of the content
export class ManagedPublicationTextError extends ManagedUnprocessableException {
  constructor(
    public readonly reason: ManagedPublicationTextRefusal,
    msg: string
  ) {
    super('CONTENT_NOT_CANONICAL', `${reason}: ${msg}`);
  }
}

export interface ManagedPublicationTextInput {
  codec: ManagedCaptionCodec;
  // the content as stored, encoded with `codec`
  content: string;
  // the provider's editor (social.integrations.interface.ts). Only 'normal'
  // was checked against the vectors, every other editor is refused
  editor: 'none' | 'normal' | 'markdown' | 'html';
}

// the text escapes of the sanitizer serializer, and nothing else
const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '\u{a0}': '&nbsp;',
};

const ENTITIES = Object.entries(ESCAPES).map(([char, entity]) => [
  entity,
  char,
]);

const PARAGRAPH = ['<p>', '</p>'] as const;

const refused = (reason: ManagedPublicationTextRefusal, msg: string) =>
  new ManagedPublicationTextError(reason, msg);

// NUL, CR and every other C0 control but LF and TAB, DEL, C1, U+2028 and
// U+2029 (surrogates are checked as pairs by the caller)
const unrepresentable = (unit: number) =>
  (unit < 0x20 && unit !== 0x09 && unit !== 0x0a) ||
  (unit >= 0x7f && unit <= 0x9f) ||
  unit === 0x2028 ||
  unit === 0x2029;

const encode = (codec: ManagedCaptionCodec, plain: string) => {
  const escaped = Array.from(plain, (char) => ESCAPES[char] ?? char).join('');
  return codec === 'ww-plain-paragraph-escape-v1'
    ? `${PARAGRAPH[0]}${escaped}${PARAGRAPH[1]}`
    : escaped;
};

// one pass: an entity is replaced by its character and the result is never
// read again, so "&amp;lt;" stays the text "&lt;"
const decodeEscapedText = (text: string, offset: number) => {
  let plain = '';
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    const unit = text.charCodeAt(index);

    if (char === '&') {
      const entity = ENTITIES.find(([name]) => text.startsWith(name, index));
      if (!entity) {
        throw refused(
          'ENTITY_NOT_CANONICAL',
          `an "&" that does not start &amp; &lt; &gt; or &nbsp; at offset ${offset + index}`
        );
      }

      plain += entity[1];
      index += entity[0].length - 1;
    } else if (char === '<' || char === '>') {
      throw refused(
        'RAW_ANGLE_BRACKET',
        `markup or an unescaped angle bracket at offset ${offset + index}`
      );
    } else if (unit === 0xa0) {
      throw refused(
        'RAW_NO_BREAK_SPACE',
        `a no-break space not written as &nbsp; at offset ${offset + index}`
      );
    } else if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw refused(
          'UNREPRESENTABLE_CODE_POINT',
          `a lone surrogate at offset ${offset + index}`
        );
      }

      plain += text.slice(index, index + 2);
      index++;
    } else if ((unit >= 0xdc00 && unit <= 0xdfff) || unrepresentable(unit)) {
      throw refused(
        'UNREPRESENTABLE_CODE_POINT',
        `U+${unit.toString(16).toUpperCase().padStart(4, '0')} at offset ${offset + index}`
      );
    } else {
      plain += char;
    }
  }

  return plain;
};

// the plain text W&W encoded, or a ManagedPublicationTextError
export function decodeManagedPublicationText({
  codec,
  content,
  editor,
}: ManagedPublicationTextInput): string {
  if (!MANAGED_CAPTION_CODECS.includes(codec)) {
    throw refused('CODEC_NOT_SUPPORTED', 'the codec is not a managed caption codec');
  }

  if (editor !== 'normal') {
    throw refused(
      'EDITOR_NOT_SUPPORTED',
      'only a provider with the normal editor can take a managed caption'
    );
  }

  if (typeof content !== 'string') {
    throw refused('CONTENT_NOT_STRING', 'the content is not a string');
  }

  if (
    content.length > MANAGED_PUBLICATION_TEXT_MAX_CODE_UNITS ||
    !maxLength(content, MANAGED_PUBLICATION_TEXT_MAX_LENGTH)
  ) {
    throw refused(
      'CONTENT_TOO_LONG',
      `the content is over ${MANAGED_PUBLICATION_TEXT_MAX_LENGTH} characters or ${MANAGED_PUBLICATION_TEXT_MAX_CODE_UNITS} UTF-16 code units`
    );
  }

  let text = content;
  let offset = 0;
  if (codec === 'ww-plain-paragraph-escape-v1') {
    if (
      content.length < PARAGRAPH[0].length + PARAGRAPH[1].length ||
      !content.startsWith(PARAGRAPH[0]) ||
      !content.endsWith(PARAGRAPH[1])
    ) {
      throw refused(
        'WRAPPER_INVALID',
        `the content is not exactly one ${PARAGRAPH[0]}...${PARAGRAPH[1]}`
      );
    }

    offset = PARAGRAPH[0].length;
    text = content.slice(offset, -PARAGRAPH[1].length);
  }

  const plain = decodeEscapedText(text, offset);
  if (encode(codec, plain) !== content) {
    throw refused(
      'ROUND_TRIP_MISMATCH',
      `the decoded text does not encode back to the content with ${codec}`
    );
  }

  return plain;
}
