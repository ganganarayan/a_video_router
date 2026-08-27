-- Descending pack pricing. A pack's discount is delivered as bonus wallet credit:
-- the customer PAYS the (possibly discounted) charge base, but the wallet is
-- CREDITED the full face value (units × base rate), so per-upload deduction
-- (fixed ₹50/unit) is unaffected. credit_paise records the face value to credit;
-- base_paise stays the charged pre-tax amount (the GST basis).
ALTER TABLE payments ADD COLUMN IF NOT EXISTS credit_paise BIGINT;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS units        INTEGER;

-- Existing top-ups were 1:1 (charge base == credit), so backfill credit = base.
UPDATE payments SET credit_paise = base_paise WHERE credit_paise IS NULL;
