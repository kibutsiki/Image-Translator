//Buttons
const TranslateButton = document.getElementById("Translate-Id");
language = document.getElementById("language-Id");
const formData = new FormData();
imageURL = [];
Translate.onclick = function() {
    imagesURL = Array.from(document.querySelectorAll("img")).map(img => img.src);
    if (imagesURL.length === 0) {
        alert("No images found to translate.");
        return;
    }
    translateImage(imagesURL, language.value);
}

async function translateImage(images, language) {
  let data;
  try{
    const response = await fetch("images")
    data = await response.blob();
  }
  catch(e){
    console.error("Failed to Fetch Image", e);
  }

  const formData = new FormData();
  formData.append("language", language);
  if(data){
    formData.append("images", data, "image.png");
  }
  else{
    console.error("No image data to append to formData");
    return;
  }
}