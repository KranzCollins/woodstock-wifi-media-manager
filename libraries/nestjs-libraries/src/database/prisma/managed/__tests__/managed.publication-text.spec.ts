// The strict publication-text leaf, checked against the shared caption
// vectors with the REAL editor sanitizer and plain-text helpers; nothing here
// is mocked. This proves the leaf's decoding only: the leaf is not wired into
// dispatch yet and publication stays NOT_QUALIFIED
import { readFileSync } from 'fs';
import { join } from 'path';
import { maxLength } from 'class-validator';
import {
  postContentPlainText,
  sanitizePostContent,
} from '@gitroom/helpers/utils/sanitize.post.content';
import { stripHtmlValidation } from '@gitroom/helpers/utils/strip.html.validation';
import { ManagedUnprocessableException } from '@gitroom/nestjs-libraries/database/prisma/managed/managed.errors';
import {
  decodeManagedPublicationText,
  MANAGED_CAPTION_CODECS,
  MANAGED_PUBLICATION_TEXT_MAX_CODE_UNITS,
  MANAGED_PUBLICATION_TEXT_MAX_LENGTH,
  MANAGED_PUBLICATION_TEXT_RULES,
  ManagedPublicationTextError,
} from '@gitroom/nestjs-libraries/database/prisma/managed/managed.publication-text';

const fixture = JSON.parse(
  readFileSync(join(__dirname, '..', 'canonical.caption.vectors.json'), 'utf8')
);

const TAGLESS = 'ww-plain-escape-v1';
const PARAGRAPH = 'ww-plain-paragraph-escape-v1';
const CODECS = [TAGLESS, PARAGRAPH] as const;

// the codec, written out from the fixture's own declaration (not the leaf's)
const encode = (codec: string, plain: string) => {
  const { escapes, wrapper } = fixture.codecs[codec];
  const escaped = [...plain].map((char) => escapes[char] ?? char).join('');
  return wrapper ? `${wrapper[0]}${escaped}${wrapper[1]}` : escaped;
};

// the same text in either form, for refusals that do not depend on the form
const wrap = (codec: string, text: string) =>
  codec === PARAGRAPH ? `<p>${text}</p>` : text;

const char = (...units: number[]) => String.fromCharCode(...units);

const decode = (codec: unknown, content: unknown, editor: unknown = 'normal') =>
  decodeManagedPublicationText({ codec, content, editor } as any);

// the refusal reason, or ACCEPTED
const outcome = (codec: unknown, content: unknown, editor: unknown = 'normal') => {
  try {
    decode(codec, content, editor);
  } catch (err) {
    if (err instanceof ManagedPublicationTextError) {
      return err.reason;
    }
    throw err;
  }
  return 'ACCEPTED';
};

// mulberry32: the same strings on every run
const random = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let value = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
  return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
};

const TOKENS = [
  'a', 'Z', '7', ' ', '.', ';', '#', '/', 'p', '&', '<', '>', '"', "'",
  '\n', '\t', 'é', '–', '🎉', '👩🏽‍💻', char(0xa0), char(0xfe0f),
  '&amp;', '&lt;', '&gt;', '&nbsp;', '&quot;', '&#39;', '&copy', '<p>', '</p>',
];

const plainOf = (next: () => number) =>
  Array.from(
    { length: 1 + Math.floor(next() * 24) },
    () => TOKENS[Math.floor(next() * TOKENS.length)]
  ).join('');

describe('decodeManagedPublicationText (real leaf)', () => {
  it('declares a separate stricter publication policy without changing DRAFT acceptance', () => {
    expect(MANAGED_PUBLICATION_TEXT_RULES).toMatchObject({
      version: 'ww-managed-publication-text-v1',
      codecs: CODECS,
      editors: ['normal'],
      entities: ['&amp;', '&lt;', '&gt;', '&nbsp;'],
      refusedInput: ['C0_EXCEPT_LF_TAB', 'DEL', 'C1', 'U+2028', 'U+2029', 'LONE_SURROGATE'],
      maxCharacters: 100000,
      maxUtf16CodeUnits: 300000,
      legacyDraftAcceptanceDoesNotQualifyPublication: true,
    });
    for (const codec of CODECS) {
      for (const unit of [0, 1, 13, 31, 127, 128, 159, 0x2028, 0x2029, 0xd800]) {
        expect(outcome(codec, wrap(codec, char(unit)))).toBe('UNREPRESENTABLE_CODE_POINT');
      }
    }
  });

  it('takes exactly the codecs of the shared vectors', () => {
    expect([...MANAGED_CAPTION_CODECS].sort()).toEqual(
      Object.keys(fixture.codecs).sort()
    );
  });

  describe.each(fixture.vectors.map((vector: any) => [vector.name, vector]) as [string, any][])(
    '%s',
    (_name, vector: any) => {
      it.each(CODECS)('%s decodes to the exact plain text and review text', (codec) => {
        expect(decode(codec, vector[codec])).toBe(vector.plain);
        expect(decode(codec, vector[codec])).toBe(
          postContentPlainText(vector[codec])
        );
      });
    }
  );

  // the tagless form W&W already stores drafts in stays readable
  it('decodes every tagless vector without asking for a paragraph', () => {
    for (const vector of fixture.vectors) {
      expect(vector[TAGLESS].startsWith('<p>')).toBe(false);
      expect(outcome(TAGLESS, vector[TAGLESS])).toBe('ACCEPTED');
    }
  });

  describe.each(CODECS)('%s edge cases', (codec) => {
    it.each([
      ['&lt;b&gt;'],
      ['&nbsp;'],
      ['&quot;'],
      ['&#39;'],
      ['&amp;'],
      ['&amp;amp;'],
      ['&lt;/p&gt;&lt;p&gt;'],
      ['&copy 2026'],
      [`non${char(0xa0)}breaking`],
      [char(0xa0)],
      ['tab\tand\nLF "double" \'single\''],
      ['\n\n'],
      [`🎉${char(0xfe0f)} 👩🏽‍💻`],
      ['<script>alert(1)</script>'],
    ])('keeps %j exactly', (plain) => {
      const content = encode(codec, plain);
      expect(decode(codec, content)).toBe(plain);
      expect(sanitizePostContent(content)).toBe(content);
      expect(postContentPlainText(content)).toBe(plain);
    });

    it('keeps literal entity text literal and a no-break space a no-break space', () => {
      expect(decode(codec, wrap(codec, '&amp;lt;b&amp;gt;'))).toBe('&lt;b&gt;');
      expect(decode(codec, wrap(codec, '&amp;nbsp;'))).toBe('&nbsp;');
      expect(decode(codec, wrap(codec, '&amp;quot;&amp;#39;'))).toBe('&quot;&#39;');
      expect(decode(codec, wrap(codec, 'a&nbsp;b'))).toBe(`a${char(0xa0)}b`);
      expect(decode(codec, wrap(codec, 'a&nbsp;b'))).not.toBe('a b');
    });

    it('decodes the empty text', () => {
      expect(decode(codec, encode(codec, ''))).toBe('');
    });

    it.each([
      ['A & B', 'ENTITY_NOT_CANONICAL'],
      ['&amp', 'ENTITY_NOT_CANONICAL'],
      ['&nbsp', 'ENTITY_NOT_CANONICAL'],
      ['&AMP;', 'ENTITY_NOT_CANONICAL'],
      ['&Nbsp;', 'ENTITY_NOT_CANONICAL'],
      ['&quot;', 'ENTITY_NOT_CANONICAL'],
      ['&#39;', 'ENTITY_NOT_CANONICAL'],
      ['&#38;', 'ENTITY_NOT_CANONICAL'],
      ['&#x26;', 'ENTITY_NOT_CANONICAL'],
      ['&copy;', 'ENTITY_NOT_CANONICAL'],
      ['&copy 2026', 'ENTITY_NOT_CANONICAL'],
      ['a &', 'ENTITY_NOT_CANONICAL'],
      ['a < b', 'RAW_ANGLE_BRACKET'],
      ['a > b', 'RAW_ANGLE_BRACKET'],
      ['a<br>b', 'RAW_ANGLE_BRACKET'],
      ['<strong>a</strong>', 'RAW_ANGLE_BRACKET'],
      ['a</p><p>b', 'RAW_ANGLE_BRACKET'],
      [`non${char(0xa0)}breaking`, 'RAW_NO_BREAK_SPACE'],
      [`a${char(0)}b`, 'UNREPRESENTABLE_CODE_POINT'],
      ['a\rb', 'UNREPRESENTABLE_CODE_POINT'],
      ['a\r\nb', 'UNREPRESENTABLE_CODE_POINT'],
      [char(0x01), 'UNREPRESENTABLE_CODE_POINT'],
      [char(0x0b), 'UNREPRESENTABLE_CODE_POINT'],
      [char(0x0c), 'UNREPRESENTABLE_CODE_POINT'],
      [char(0x1b), 'UNREPRESENTABLE_CODE_POINT'],
      [char(0x1f), 'UNREPRESENTABLE_CODE_POINT'],
      [char(0x7f), 'UNREPRESENTABLE_CODE_POINT'],
      [char(0x80), 'UNREPRESENTABLE_CODE_POINT'],
      [char(0x85), 'UNREPRESENTABLE_CODE_POINT'],
      [char(0x9f), 'UNREPRESENTABLE_CODE_POINT'],
      [char(0x2028), 'UNREPRESENTABLE_CODE_POINT'],
      [char(0x2029), 'UNREPRESENTABLE_CODE_POINT'],
      [char(0xd800), 'UNREPRESENTABLE_CODE_POINT'],
      [`a${char(0xdc00)}b`, 'UNREPRESENTABLE_CODE_POINT'],
      [char(0xdc00, 0xd800), 'UNREPRESENTABLE_CODE_POINT'],
      [`x${char(0xdbff)}`, 'UNREPRESENTABLE_CODE_POINT'],
    ])('refuses %j as %s', (text, reason) => {
      expect(outcome(codec, wrap(codec, text))).toBe(reason);
    });

    it.each(fixture.refusedInput.map((item: any) => [item.name, item.plain]) as [string, string][])(
      'refuses the encoding of the shared refused input: %s',
      (_name, plain) => {
        expect(outcome(codec, encode(codec, plain))).toBe(
          'UNREPRESENTABLE_CODE_POINT'
        );
      }
    );
  });

  it.each([
    ['Caption'],
    [''],
    ['<p>'],
    ['</p>'],
    ['<p></p'],
    ['<p class="x">a</p>'],
    ['<p dir="auto">a</p>'],
    ['<P>a</P>'],
    [' <p>a</p>'],
    ['<p>a</p>\n'],
    ['<p>a</p> '],
  ])('refuses %j as not exactly one paragraph', (content) => {
    expect(outcome(PARAGRAPH, content)).toBe('WRAPPER_INVALID');
  });

  it.each([['<p>a</p><p>b</p>'], ['<p><p>a</p></p>'], ['<p>a<br>b</p>']])(
    'refuses %j: no tag inside the one paragraph',
    (content) => {
      expect(outcome(PARAGRAPH, content)).toBe('RAW_ANGLE_BRACKET');
    }
  );

  // a codec mix-up is refused, never guessed
  it('refuses paragraph content declared as the tagless codec', () => {
    expect(outcome(TAGLESS, '<p>Caption</p>')).toBe('RAW_ANGLE_BRACKET');
    expect(outcome(PARAGRAPH, 'Caption')).toBe('WRAPPER_INVALID');
  });

  it.each(fixture.notFixedPoints.map((item: any) => [item.html]) as [string][])(
    'refuses the non-canonical paragraph %j',
    (html) => {
      expect(outcome(PARAGRAPH, html)).not.toBe('ACCEPTED');
    }
  );

  // the sanitizer gate cannot see these, the leaf does
  it.each(fixture.taglessPassThrough.map((item: any) => [item.html]) as [string][])(
    'refuses the unescaped tagless %j',
    (html) => {
      expect(outcome(TAGLESS, html)).not.toBe('ACCEPTED');
    }
  );

  it.each([['ww-plain-escape-v2'], [''], [undefined], ['WW-PLAIN-ESCAPE-V1']])(
    'refuses the codec %j',
    (codec) => {
      expect(outcome(codec, 'Caption')).toBe('CODEC_NOT_SUPPORTED');
    }
  );

  it.each([['none'], ['markdown'], ['html'], [undefined], ['NORMAL']])(
    'refuses the editor %j',
    (editor) => {
      for (const codec of CODECS) {
        // Call the leaf directly: the convenience helper defaults an undefined
        // editor to normal and cannot represent this malformed boundary input.
        expect(() => decodeManagedPublicationText({
          codec, content: encode(codec, 'Caption'), editor,
        } as any)).toThrow(expect.objectContaining({ reason: 'EDITOR_NOT_SUPPORTED' }));
      }
    }
  );

  it.each([[null], [undefined], [42], [['a']], [{ toString: () => 'a' }]])(
    'refuses the content %j',
    (content) => {
      expect(outcome(TAGLESS, content)).toBe('CONTENT_NOT_STRING');
    }
  );

  describe('length bound', () => {
    const max = MANAGED_PUBLICATION_TEXT_MAX_LENGTH;

    it('is the members[].content @MaxLength of the write path', () => {
      expect(max).toBe(100000);
      expect(MANAGED_PUBLICATION_TEXT_MAX_CODE_UNITS).toBe(300000);
    });

    it('takes content up to the bound and refuses one more', () => {
      expect(decode(TAGLESS, 'a'.repeat(max))).toBe('a'.repeat(max));
      expect(outcome(TAGLESS, 'a'.repeat(max + 1))).toBe('CONTENT_TOO_LONG');
      expect(decode(PARAGRAPH, `<p>${'a'.repeat(max - 7)}</p>`)).toBe(
        'a'.repeat(max - 7)
      );
      expect(outcome(PARAGRAPH, `<p>${'a'.repeat(max - 6)}</p>`)).toBe(
        'CONTENT_TOO_LONG'
      );
    });

    // whatever the DTO accepted for its length, the leaf accepts too
    it.each([
      ['emoji at the bound', '🎉'.repeat(max)],
      ['emoji over the bound', '🎉'.repeat(max + 1)],
      ['variation selectors at the code unit bound', char(0xfe0f).repeat(3 * max)],
    ])('measures %s like the DTO', (_name, content) => {
      expect(outcome(TAGLESS, content) === 'ACCEPTED').toBe(maxLength(content, max));
    });

    it('refuses more code units than the hard bound whatever the DTO measure says', () => {
      expect(outcome(TAGLESS, char(0xfe0f).repeat(3 * max + 1))).toBe(
        'CONTENT_TOO_LONG'
      );
    });

    it('checks the length before it reads the content', () => {
      expect(outcome(TAGLESS, `${'a'.repeat(max)}${char(0)}`)).toBe(
        'CONTENT_TOO_LONG'
      );
    });
  });

  it('throws the existing CONTENT_NOT_CANONICAL 422 without the content in it', () => {
    for (const [codec, content] of [
      [TAGLESS, 'SECRET & caption'],
      [TAGLESS, `SECRET${char(0xa0)}caption`],
      [PARAGRAPH, '<p>SECRET <b>caption</b></p>'],
      [PARAGRAPH, 'SECRET caption'],
      [PARAGRAPH, `<p>SECRET${char(0)}</p>`],
    ]) {
      let error: any;
      try {
        decode(codec, content);
      } catch (err) {
        error = err;
      }

      expect(error).toBeInstanceOf(ManagedPublicationTextError);
      expect(error).toBeInstanceOf(ManagedUnprocessableException);
      expect(error.getStatus()).toBe(422);
      expect(error.code).toBe('CONTENT_NOT_CANONICAL');
      expect(error.getResponse()).toEqual({
        code: 'CONTENT_NOT_CANONICAL',
        msg: expect.stringMatching(new RegExp(`^${error.reason}: `)),
      });
      expect(JSON.stringify(error.getResponse())).not.toContain('SECRET');
      expect(error.message).not.toContain('SECRET');
    }
  });

  describe.each(CODECS)('%s deterministic properties', (codec) => {
    it('decodes every generated encoding to its plain text, which is the review text', () => {
      const next = random(0x5eed);
      for (let run = 0; run < 200; run++) {
        const plain = plainOf(next);
        const content = encode(codec, plain);
        expect([plain, decode(codec, content)]).toEqual([plain, plain]);
        expect([plain, sanitizePostContent(content)]).toEqual([plain, content]);
        expect([plain, postContentPlainText(content)]).toEqual([plain, plain]);
      }
    });

    it('refuses every generated encoding with one raw character put in its text', () => {
      const RAW = ['<', '>', char(0xa0), char(0), '\r', char(0x7f), char(0x85), char(0x2028), char(0xd800)];
      const next = random(0xbad);
      for (let run = 0; run < 200; run++) {
        const content = encode(codec, plainOf(next));
        const [start, end] =
          codec === PARAGRAPH ? [3, content.length - 4] : [0, content.length];
        const at = start + Math.floor(next() * (end - start + 1));
        const mutated = `${content.slice(0, at)}${RAW[Math.floor(next() * RAW.length)]}${content.slice(at)}`;
        expect([mutated, outcome(codec, mutated)]).not.toEqual([mutated, 'ACCEPTED']);
      }
    });
  });
});

// Frozen, not changed: what upstream stripHtmlValidation makes of the vectors
// with the arguments post.activity.ts passes before a provider (replaceBold,
// `plain` for content without a tag, no mention format, no inline images).
// The leaf is not used there; these are the recorded publication defects
describe('legacy stripHtmlValidation with the dispatch arguments (unchanged)', () => {
  const TAG = /<\/?[a-z][\s\S]*>/i;
  const MODES = ['none', 'normal', 'markdown', 'html'] as const;
  const legacy = (mode: (typeof MODES)[number], content: string) =>
    stripHtmlValidation(mode, content, true, false, !TAG.test(content), undefined);
  const vector = (name: string) =>
    fixture.vectors.find((item: any) => item.name === name);

  it.each(MODES)('%s returns every tagless vector as is, entities encoded', (mode) => {
    for (const item of fixture.vectors) {
      expect([item.name, legacy(mode, item[TAGLESS])]).toEqual([item.name, item[TAGLESS]]);
    }
  });

  it.each([
    ['ampersand', { none: 'A & B', normal: 'A & B', markdown: 'A & B\n', html: '<p>A & B</p>' }],
    [
      'literal entity text (lt / gt)',
      { none: '&lt;b&gt;', normal: '<b>', markdown: '<b>\n', html: '<p>&lt;b&gt;</p>' },
    ],
    [
      'no-break space',
      {
        none: 'non breaking',
        normal: 'non breaking',
        markdown: 'non breaking\n',
        html: '<p>non breaking</p>',
      },
    ],
    [
      'quotes stay literal',
      {
        none: '"double" and \'single\'',
        normal: '"double" and \'single\'',
        markdown: '"double" and \'single\'\n',
        html: '<p>"double" and \'single\'</p>',
      },
    ],
    [
      'newlines and an empty line',
      {
        none: 'line 1\nline 2\n\nline 4',
        normal: 'line 1\nline 2\n\nline 4',
        markdown: 'line 1\nline 2\n\nline 4\n',
        html: '<p>line 1\nline 2\n\nline 4</p>',
      },
    ],
  ])('paragraph %s', (name, expected: Record<string, string>) => {
    const item = vector(name);
    for (const mode of MODES) {
      expect([mode, legacy(mode, item[PARAGRAPH])]).toEqual([mode, expected[mode]]);
    }
  });

  it('differs from the leaf exactly where the recorded defects are', () => {
    const nbsp = vector('no-break space');
    expect(legacy('normal', nbsp[PARAGRAPH])).toBe('non breaking');
    expect(decode(PARAGRAPH, nbsp[PARAGRAPH])).toBe(`non${char(0xa0)}breaking`);

    const literal = vector('literal entity text (lt / gt)');
    expect(legacy('normal', literal[PARAGRAPH])).toBe('<b>');
    expect(decode(PARAGRAPH, literal[PARAGRAPH])).toBe('&lt;b&gt;');

    const ampersand = vector('ampersand');
    expect(legacy('normal', ampersand[TAGLESS])).toBe('A &amp; B');
    expect(decode(TAGLESS, ampersand[TAGLESS])).toBe('A & B');
  });
});
