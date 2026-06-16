<template>
  <div class="markdown-body" v-html="rendered"></div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import MarkdownIt from "markdown-it";

const md = new MarkdownIt({
  html: false,
  breaks: false,
  linkify: true,
  typographer: true,
});

const props = defineProps<{ content: string }>();

const rendered = computed(() => {
  if (!props.content) return "";
  try {
    return md.render(props.content);
  } catch {
    return props.content;
  }
});
</script>

<style lang="scss" scoped>
.markdown-body {
  :deep(> *:first-child) {
    margin-top: 0;
  }
  :deep(> *:last-child) {
    margin-bottom: 0;
  }

  :deep(p) {
    margin: 0.4em 0;
    &:first-child { margin-top: 0; }
    &:last-child { margin-bottom: 0; }
  }

  :deep(h1), :deep(h2), :deep(h3), :deep(h4), :deep(h5), :deep(h6) {
    margin: 0.6em 0 0.3em;
    font-weight: 600;
    line-height: 1.3;
    &:first-child { margin-top: 0; }
  }
  :deep(h1) { font-size: 1.3em; }
  :deep(h2) { font-size: 1.2em; }
  :deep(h3) { font-size: 1.1em; }
  :deep(h4), :deep(h5), :deep(h6) { font-size: 1em; }

  :deep(ul), :deep(ol) {
    margin: 0.4em 0;
    padding-left: 1.5em;
  }
  :deep(li) {
    margin: 0.2em 0;

    > p {
      margin: 0;
    }
  }

  :deep(blockquote) {
    margin: 0.4em 0;
    padding: 0.2em 0.8em;
    border-left: 3px solid var(--color-border, #dee2e6);
    color: var(--color-text-secondary, #6c757d);
  }

  :deep(code) {
    font-family: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace;
    font-size: 0.88em;
    padding: 0.15em 0.35em;
    border-radius: 4px;
    background-color: rgba(0, 0, 0, 0.06);
  }

  :deep(pre) {
    margin: 0.5em 0;
    padding: 0.8em 1em;
    border-radius: 8px;
    background-color: rgba(0, 0, 0, 0.06);
    overflow-x: auto;
    line-height: 1.45;

    code {
      padding: 0;
      background: none;
      font-size: 0.85em;
    }
  }

  :deep(table) {
    width: 100%;
    border-collapse: collapse;
    margin: 0.5em 0;
    font-size: 0.92em;
  }
  :deep(th), :deep(td) {
    border: 1px solid var(--color-border, #dee2e6);
    padding: 0.4em 0.6em;
    text-align: left;
  }
  :deep(th) {
    font-weight: 600;
    background-color: rgba(0, 0, 0, 0.03);
  }

  :deep(hr) {
    border: none;
    border-top: 1px solid var(--color-border, #dee2e6);
    margin: 0.6em 0;
  }

  :deep(a) {
    color: rgba(99, 102, 241, 1);
    text-decoration: none;
    &:hover {
      text-decoration: underline;
    }
  }

  :deep(strong) {
    font-weight: 600;
  }

  :deep(img) {
    max-width: 100%;
    border-radius: 6px;
  }
}
</style>
