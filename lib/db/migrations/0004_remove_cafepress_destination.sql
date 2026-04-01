-- Remove 'cafepress' from the affiliate_destination enum.
-- Existing cafepress rows are migrated to 'zazzle' before the enum is altered.

-- Step 1: Change the column to text so we can update values freely
ALTER TABLE affiliate_clicks ALTER COLUMN destination TYPE text USING destination::text;

-- Step 2: Migrate any historical cafepress clicks to zazzle
UPDATE affiliate_clicks SET destination = 'zazzle' WHERE destination = 'cafepress';

-- Step 3: Create the new enum with only the supported destination
CREATE TYPE affiliate_destination_new AS ENUM ('zazzle');

-- Step 4: Apply the new enum type to the column
ALTER TABLE affiliate_clicks
  ALTER COLUMN destination TYPE affiliate_destination_new
  USING destination::affiliate_destination_new;

-- Step 5: Drop the old enum type
DROP TYPE affiliate_destination;

-- Step 6: Rename to the original type name
ALTER TYPE affiliate_destination_new RENAME TO affiliate_destination;
