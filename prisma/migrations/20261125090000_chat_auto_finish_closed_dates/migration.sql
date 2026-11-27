CREATE TABLE IF NOT EXISTS `chat_auto_finish_closed_dates` (
    `instance` VARCHAR(191) NOT NULL,
    `date` DATE NOT NULL,

    PRIMARY KEY (`instance`, `date`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
