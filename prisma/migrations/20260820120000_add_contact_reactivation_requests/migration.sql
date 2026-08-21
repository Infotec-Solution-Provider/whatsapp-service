-- AlterTable
ALTER TABLE `notifications`
    ADD COLUMN `action_url` VARCHAR(191) NULL,
    MODIFY `type` ENUM(
        'CHAT_AUTO_FINISHED',
        'CHAT_TRANSFERRED',
        'CHAT_REASSIGNED',
        'ALERT',
        'INFO',
        'WARNING',
        'ERROR',
        'CONTACT_ACTION_REQUEST'
    ) NOT NULL;

-- CreateTable
CREATE TABLE `contact_action_requests` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `instance` VARCHAR(191) NOT NULL,
    `contact_id` INTEGER NOT NULL,
    `action` ENUM('REACTIVATE', 'DELETE') NOT NULL,
    `requested_by` INTEGER NOT NULL,
    `requested_by_name` VARCHAR(191) NULL,
    `payload` JSON NULL,
    `contact_snapshot` JSON NOT NULL,
    `status` ENUM('PENDING', 'APPROVED', 'REJECTED') NOT NULL DEFAULT 'PENDING',
    `pending_key` VARCHAR(191) NULL,
    `reviewed_by` INTEGER NULL,
    `reviewed_at` DATETIME(3) NULL,
    `review_note` VARCHAR(500) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `contact_action_requests_pending_key_key`(`pending_key`),
    INDEX `contact_action_requests_instance_status_action_created_at_idx`(`instance`, `status`, `action`, `created_at`),
    INDEX `contact_action_requests_contact_id_action_status_idx`(`contact_id`, `action`, `status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `contact_action_requests`
    ADD CONSTRAINT `contact_action_requests_contact_id_fkey`
    FOREIGN KEY (`contact_id`) REFERENCES `contacts`(`id`)
    ON DELETE CASCADE ON UPDATE CASCADE;
