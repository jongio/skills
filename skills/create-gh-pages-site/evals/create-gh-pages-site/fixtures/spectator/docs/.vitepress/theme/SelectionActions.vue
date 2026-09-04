<script setup lang="ts">
const selectedText = () => window.getSelection()?.toString() || "";
</script>

<template>
  <button type="button" data-action="selected-text-feedback">
    Create issue
  </button>
  <a href="https://github.com/__REPO_SLUG__/edit/main/docs/index.md">
    Edit page
  </a>
  <span hidden>{{ selectedText() }}</span>
</template>
