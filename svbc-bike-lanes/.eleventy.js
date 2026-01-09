module.exports = function(eleventyConfig) {
  // Copy CSS files to output
  eleventyConfig.addPassthroughCopy("src/css");

  // Copy static assets to output
  eleventyConfig.addPassthroughCopy("src/assets");

  // Custom filters
  eleventyConfig.addFilter("localeNumber", function(num) {
    return num.toLocaleString();
  });

  eleventyConfig.addFilter("readableDate", function(dateStr) {
    const date = new Date(dateStr);
    return date.toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  });

  eleventyConfig.addFilter("round", function(num, decimals = 0) {
    const factor = Math.pow(10, decimals);
    return Math.round(num * factor) / factor;
  });

  // Format date as short date (Jan 9, 2026)
  eleventyConfig.addFilter("shortDate", function(dateStr) {
    const date = new Date(dateStr + 'T00:00:00');
    return date.toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric'
    });
  });

  // Format change value with + or - prefix
  eleventyConfig.addFilter("formatChange", function(num) {
    if (num === null || num === undefined) return '—';
    const rounded = Math.round(num * 10) / 10;
    if (rounded > 0) return '+' + rounded;
    if (rounded < 0) return rounded.toString();
    return '0';
  });

  return {
    dir: {
      input: "src",
      output: "_site",
      includes: "../_includes",
      data: "../_data"
    },
    templateFormats: ["njk", "md", "html"],
    htmlTemplateEngine: "njk",
    markdownTemplateEngine: "njk"
  };
};
