const DEFAULT_VAT_RATE = 7;

function roundMoney(value) {
  const amount = Number(value) || 0;
  return Math.round(amount * 100) / 100;
}

function isVatEnabled(settings) {
  return Number(settings?.vat_enabled ?? settings?.vatEnabled ?? 0) === 1 || settings?.vatEnabled === true;
}

function vatRate(settings) {
  const rate = Number(settings?.vat_rate ?? settings?.vatRate ?? DEFAULT_VAT_RATE);
  return Number.isFinite(rate) && rate > 0 ? rate : DEFAULT_VAT_RATE;
}

function applyVatToAmount(amount, settings) {
  const baseAmount = roundMoney(amount);
  if (!isVatEnabled(settings)) return baseAmount;
  return roundMoney(baseAmount + (baseAmount * vatRate(settings)) / 100);
}

async function getOrganizationVatSettings(executor, organizationId) {
  const result = await executor.execute(
    `SELECT vat_enabled, vat_rate
     FROM organizations
     WHERE id = :organizationId
     LIMIT 1`,
    { organizationId },
  );
  const rows = Array.isArray(result[0]) ? result[0] : result;
  return rows[0] || { vat_enabled: 0, vat_rate: DEFAULT_VAT_RATE };
}

module.exports = {
  DEFAULT_VAT_RATE,
  applyVatToAmount,
  getOrganizationVatSettings,
  isVatEnabled,
  roundMoney,
  vatRate,
};
