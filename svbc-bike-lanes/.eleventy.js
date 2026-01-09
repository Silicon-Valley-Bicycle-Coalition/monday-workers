const { writeCSVFiles } = require('./_data/csvExport');

module.exports = function(eleventyConfig) {
  // Copy CSS files to output
  eleventyConfig.addPassthroughCopy("src/css");

  // Copy static assets to output
  eleventyConfig.addPassthroughCopy("src/assets");

  // Generate CSV export files after build
  eleventyConfig.on('eleventy.after', async ({ dir }) => {
    const bikelanes = require('./_data/bikelanes');
    const history = require('./_data/history.json');

    // bikelanes is an async function, so we need to call it
    const bikelanesData = await bikelanes();
    await writeCSVFiles(bikelanesData, history, dir.output);
  });

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

  // Convert miles to kilometers
  eleventyConfig.addFilter("toKm", function(miles) {
    if (miles === null || miles === undefined) return miles;
    return miles * 1.60934;
  });

  // Format distance with unit conversion
  // Wraps decimal portion in span for styling
  eleventyConfig.addFilter("formatDistance", function(miles, unit) {
    if (miles === null || miles === undefined) return '—';
    const value = unit === 'km' ? miles * 1.60934 : miles;
    const rounded = Math.round(value * 10) / 10;
    const formatted = rounded.toLocaleString();
    // Split at decimal point and wrap decimal portion
    const parts = formatted.split('.');
    if (parts.length === 2) {
      return `${parts[0]}<span class="decimal">.${parts[1]}</span>`;
    }
    return formatted;
  });

  // Format change value with unit conversion
  eleventyConfig.addFilter("formatChangeWithUnit", function(num, unit) {
    if (num === null || num === undefined) return '—';
    const value = unit === 'km' ? num * 1.60934 : num;
    const rounded = Math.round(value * 10) / 10;
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
