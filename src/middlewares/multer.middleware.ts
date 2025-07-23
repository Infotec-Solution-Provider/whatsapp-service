import multer from "multer";

const upload = multer({
	limits: {
		fileSize: 2 * 1024 * 1024 * 1024 // 128MB
	}
});

export default upload;
