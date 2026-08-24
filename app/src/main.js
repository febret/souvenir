import "./styles.css";

const errorElement = document.querySelector("#app-error");

function showStartupError(error) {
  errorElement.hidden = false;
  errorElement.textContent =
    error instanceof Error ? error.message : "Souvenir could not start.";
}

async function start() {
  const { HomeController } = await import("./ui/home-controller.js");
  const controller = new HomeController(document);
  await controller.start();
}

start().catch(showStartupError);
