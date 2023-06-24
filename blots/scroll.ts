import {
  Blot,
  ContainerBlot,
  LeafBlot,
  Parent,
  ParentBlot,
  Registry,
  Scope,
  ScrollBlot,
} from 'parchment';
import Delta, { AttributeMap } from 'quill-delta';
import Emitter, { EmitterSource } from '../core/emitter';
import Block, { BlockEmbed } from './block';
import Break from './break';
import Container from './container';

function isLine(blot: unknown): blot is Block | BlockEmbed {
  return blot instanceof Block || blot instanceof BlockEmbed;
}

interface UpdatableEmbed {
  updateContent(change: unknown): void;
}

function isUpdatable(blot: Blot): blot is Blot & UpdatableEmbed {
  return typeof (blot as unknown as any).updateContent === 'function';
}

function deltaToLines(delta: Delta) {
  const lines: { delta: Delta; attributes: AttributeMap }[] = [];
  // eachLine can't tell if we end in newline or not
  // add trailing newline to differentiate
  // 'hello\nworld' -> ['hello', 'world']
  // 'hello\nworld\n' -> ['hello', 'world', '']

  // TODO: insert() here modifies original delta
  delta.insert('\n').eachLine((lineDelta, attributes) => {
    lines.push({ delta: lineDelta, attributes });
  });
  return lines;
}

class Scroll extends ScrollBlot {
  static blotName = 'scroll';
  static className = 'ql-editor';
  static tagName = 'DIV';
  static defaultChild = Block;
  static allowedChildren = [Block, BlockEmbed, Container];

  emitter: Emitter;
  batch: false | MutationRecord[];

  constructor(
    registry: Registry,
    domNode: HTMLDivElement,
    { emitter }: { emitter: Emitter },
  ) {
    super(registry, domNode);
    this.emitter = emitter;
    this.batch = false;
    this.optimize();
    this.enable();
    this.domNode.addEventListener('dragstart', e => this.handleDragStart(e));
  }

  batchStart() {
    if (!Array.isArray(this.batch)) {
      this.batch = [];
    }
  }

  batchEnd() {
    if (!this.batch) return;
    const mutations = this.batch;
    this.batch = false;
    this.update(mutations);
  }

  emitMount(blot) {
    this.emitter.emit(Emitter.events.SCROLL_BLOT_MOUNT, blot);
  }

  emitUnmount(blot) {
    this.emitter.emit(Emitter.events.SCROLL_BLOT_UNMOUNT, blot);
  }

  emitEmbedUpdate(blot, change) {
    this.emitter.emit(Emitter.events.SCROLL_EMBED_UPDATE, blot, change);
  }

  deleteAt(index, length) {
    const [first, offset] = this.line(index);
    const [last] = this.line(index + length);
    super.deleteAt(index, length);
    if (last != null && first !== last && offset > 0) {
      if (first instanceof BlockEmbed || last instanceof BlockEmbed) {
        this.optimize();
        return;
      }
      const ref =
        last.children.head instanceof Break ? null : last.children.head;
      // @ts-expect-error
      first.moveChildren(last, ref);
      // @ts-expect-error
      first.remove();
    }
    this.optimize();
  }

  enable(enabled = true) {
    this.domNode.setAttribute('contenteditable', enabled ? 'true' : 'false');
  }

  formatAt(index, length, format, value) {
    super.formatAt(index, length, format, value);
    this.optimize();
  }

  handleDragStart(event) {
    event.preventDefault();
  }

  insertAt(index: number, value: string, def?: unknown) {
    if (index >= this.length()) {
      if (def == null || this.scroll.query(value, Scope.BLOCK) == null) {
        const blot = this.scroll.create(this.statics.defaultChild.blotName);
        this.appendChild(blot);
        if (def == null && value.endsWith('\n')) {
          blot.insertAt(0, value.slice(0, -1), def);
        } else {
          blot.insertAt(0, value, def);
        }
      } else {
        const embed = this.scroll.create(value, def);
        this.appendChild(embed);
      }
    } else {
      super.insertAt(index, value, def);
    }
    this.optimize();
  }

  insertBefore(blot: Blot, ref?: Blot) {
    if (blot.statics.scope === Scope.INLINE_BLOT) {
      const wrapper = this.scroll.create(
        this.statics.defaultChild.blotName,
      ) as Parent;
      wrapper.appendChild(blot);
      super.insertBefore(wrapper, ref);
    } else {
      super.insertBefore(blot, ref);
    }
  }

  insertContents(index: number, delta: Delta) {
    const [child, offset] = this.children.find(index);
    if (child == null) return;
    const lines = deltaToLines(delta);
    const first = lines.shift();
    if (first == null) return;
    this.batchStart();
    // @ts-ignore
    child.insertContents(offset, first.delta);
    const last = lines.pop();
    let after;
    if (last != null) {
      after = child.split(offset + first.delta.length(), true);
      Object.keys(first.attributes).forEach(name => {
        // @ts-ignore
        after.prev.format(name, first.attributes[name]);
      });
      after.insertContents(0, last.delta);
    }

    lines.forEach(({ delta: lineDelta, attributes }) => {
      const blockAttribute = Object.keys(attributes).find(
        key =>
          this.query(
            key,
            // eslint-disable-next-line no-bitwise
            Scope.BLOCK & Scope.BLOT,
          ) != null,
      );
      const block = this.create(
        blockAttribute || this.statics.defaultChild.blotName,
        blockAttribute ? attributes[blockAttribute] : undefined,
      );
      this.insertBefore(block, after);
      // @ts-ignore
      block.insertContents(0, lineDelta);
      Object.keys(attributes).forEach(key => {
        if (
          this.query(
            key,
            // eslint-disable-next-line no-bitwise
            Scope.BLOCK & Scope.BLOT,
          ) == null
        ) {
          block.formatAt(0, block.length(), key, attributes[key]);
        }
      });
    });

    this.batchEnd();
    this.optimize();
  }

  isEnabled() {
    return this.domNode.getAttribute('contenteditable') === 'true';
  }

  leaf(index: number): [LeafBlot | null, number] {
    const last = this.path(index).pop();
    if (!last) {
      return [null, -1];
    }

    const [blot, offset] = last;
    return blot instanceof LeafBlot ? [blot, offset] : [null, -1];
  }

  line(index: number): [Block | BlockEmbed | null, number] {
    if (index === this.length()) {
      return this.line(index - 1);
    }
    // @ts-expect-error TODO: make descendant() generic
    return this.descendant(isLine, index);
  }

  lines(index = 0, length = Number.MAX_VALUE): (Block | BlockEmbed)[] {
    const getLines = (
      blot: ParentBlot,
      blotIndex: number,
      blotLength: number,
    ) => {
      let lines: (Block | BlockEmbed)[] = [];
      let lengthLeft = blotLength;
      blot.children.forEachAt(
        blotIndex,
        blotLength,
        (child, childIndex, childLength) => {
          if (isLine(child)) {
            lines.push(child);
          } else if (child instanceof ContainerBlot) {
            lines = lines.concat(getLines(child, childIndex, lengthLeft));
          }
          lengthLeft -= childLength;
        },
      );
      return lines;
    };
    return getLines(this, index, length);
  }

  optimize(context?: { [key: string]: any }): void;
  optimize(
    mutations?: MutationRecord[],
    context?: { [key: string]: any },
  ): void;
  optimize(mutations = [], context = {}) {
    if (this.batch) return;
    super.optimize(mutations, context);
    if (mutations.length > 0) {
      this.emitter.emit(Emitter.events.SCROLL_OPTIMIZE, mutations, context);
    }
  }

  path(index: number) {
    return super.path(index).slice(1); // Exclude self
  }

  remove() {
    // Never remove self
  }

  update(source?: EmitterSource): void;
  update(mutations?: MutationRecord[]): void;
  update(mutations?: MutationRecord[] | EmitterSource): void {
    if (this.batch) {
      if (Array.isArray(mutations)) {
        this.batch = this.batch.concat(mutations);
      }
      return;
    }
    let source: EmitterSource = Emitter.sources.USER;
    if (typeof mutations === 'string') {
      source = mutations;
    }
    if (!Array.isArray(mutations)) {
      mutations = this.observer.takeRecords();
    }
    mutations = mutations.filter(({ target }) => {
      const blot = this.find(target, true);
      return blot && !isUpdatable(blot);
    });
    if (mutations.length > 0) {
      this.emitter.emit(Emitter.events.SCROLL_BEFORE_UPDATE, source, mutations);
    }
    super.update(mutations.concat([])); // pass copy
    if (mutations.length > 0) {
      this.emitter.emit(Emitter.events.SCROLL_UPDATE, source, mutations);
    }
  }

  updateEmbedAt(index: number, key: string, change: unknown) {
    // Currently it only supports top-level embeds (BlockEmbed).
    // We can update `ParentBlot` in parchment to support inline embeds.
    const [blot] = this.descendant(b => b instanceof BlockEmbed, index);
    if (blot && blot.statics.blotName === key && isUpdatable(blot)) {
      blot.updateContent(change);
    }
  }
}

export interface ScrollConstructor {
  new (
    registry: Registry,
    domNode: HTMLDivElement,
    options: { emitter: Emitter },
  ): Scroll;
}

export default Scroll;
