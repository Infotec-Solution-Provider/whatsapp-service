-- Descriptions include the contact name plus notification text, which can exceed 191 characters.
ALTER TABLE `notifications`
    MODIFY COLUMN `description` TEXT NOT NULL;
