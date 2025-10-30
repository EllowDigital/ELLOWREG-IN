DROP TABLE IF EXISTS public.registrations CASCADE; -- Uncomment this line if you need to completely reset the table

-- 1. CREATE TABLE with Updated Columns and Constraints
CREATE TABLE public.registrations (
    -- COLUMNS
    id               SERIAL PRIMARY KEY,
    timestamp        TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    registration_id  TEXT UNIQUE NOT NULL,
    name             TEXT,
    phone            TEXT UNIQUE,
    email            TEXT, -- ADDED
    city             TEXT,
    state            TEXT,
    payment_id       TEXT,
    image_url        TEXT,
    needs_sync       BOOLEAN DEFAULT 'true',
    checked_in_at    TIMESTAMP WITH TIME ZONE

    -- Note: 'company', 'address', and 'day' have been removed.
);

-- 2. INDEXES

-- Standard B-TREE index for lookups by check-in time
CREATE INDEX idx_registrations_checked_in_at
    ON public.registrations USING BTREE (checked_in_at);

-- Partial Index: Optimized for finding registrations that have NOT been checked in (WHERE checked_in_at IS NULL)
CREATE INDEX idx_registrations_not_checked_in
    ON public.registrations USING BTREE (registration_id)
    WHERE checked_in_at IS NULL;

-- Index on expression: Optimized for queries that filter by the date part of the timestamp
CREATE INDEX idx_registrations_timestamp_date
    ON public.registrations USING BTREE (("timestamp"::date));

-- Note: Indexes for 'id', 'phone', and 'registration_id' are automatically created by their UNIQUE/PRIMARY KEY constraints.